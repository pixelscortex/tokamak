use std::{
    rc::Rc,
    sync::{Arc, atomic::Ordering},
};

use anyhow::{Result, anyhow, ensure};
use engine::{
    Invocation, install_ops,
    web::{self, WebHost, WebLease},
};
use rquickjs::{
    AsyncContext, AsyncRuntime, CaughtError, Ctx, Exception, Function, Module, Object, Persistent,
    Promise, prelude::Func,
};
use serde_json::Value;

use super::{
    BUNDLE,
    call::{CallOutput, OUT_OF_MEMORY},
    number,
};

pub(super) type InvocationPromise = Persistent<Promise<'static>>;

pub(super) struct Realm {
    dispatch: Persistent<Function<'static>>,
    context: AsyncContext,
    _web: WebLease,
    _web_invocation: Invocation,
}

impl Realm {
    pub async fn new(
        runtime: &AsyncRuntime,
        source: &str,
        permissions: &[String],
        output: Rc<CallOutput>,
        worker_entry: bool,
        network: bool,
    ) -> Result<Self> {
        let web = WebHost::new(permissions.to_vec())?;
        let lease = web.lease();
        let operations = Arc::new(web.operations()?);
        let context = AsyncContext::full(runtime).await.map_err(|error| {
            if matches!(error, rquickjs::Error::Allocation) {
                anyhow!(OUT_OF_MEMORY)
            } else {
                error.into()
            }
        })?;
        let invocation = Invocation::unbounded();
        let dispatch = context
            .async_with(async |ctx| {
                let run = async {
                    // Worker entries were built for Bun and may depend on these globals.
                    if worker_entry {
                        install_builtins(&ctx).await?;
                    }
                    let capability = install_ops(&ctx, operations, &invocation)?;
                    web::install(&ctx, capability, network)?;
                    ctx.globals().set("console", Object::new(ctx.clone())?)?;

                    let (entry, evaluated) = Module::declare(
                        ctx.clone(),
                        "tokamak:actions",
                        include_str!(concat!(env!("OUT_DIR"), "/actions.js")),
                    )?
                    .eval()?;
                    evaluated.into_future::<()>().await?;
                    let logging: Function = entry.get("logging")?;
                    let initialize: Function = entry.get("initialize")?;
                    let bridge = output.bridge.clone();
                    let send = Function::new(ctx.clone(), move |ctx: Ctx<'_>, line: String| {
                        send(&output, &line)
                            .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))
                    })?;
                    logging.call::<_, ()>((send.clone(),))?;
                    let (module, evaluated) =
                        Module::declare(ctx.clone(), BUNDLE, source.as_bytes())?.eval()?;
                    evaluated.into_future::<()>().await?;
                    let functions: Object = module.get("functions")?;
                    let next_op = Func::from(move || {
                        bridge
                            .as_ref()
                            .map_or(0, |bridge| bridge.next.fetch_add(1, Ordering::Relaxed) + 1)
                            as f64
                    });
                    let dispatch: Function = initialize.call((send, next_op, functions))?;
                    Ok::<_, rquickjs::Error>(Persistent::save(&ctx, dispatch))
                }
                .await;
                run.map_err(|error| js_error(&ctx, error))
            })
            .await?;

        Ok(Self {
            dispatch,
            context,
            _web: lease,
            _web_invocation: invocation,
        })
    }

    pub async fn invoke(&self, frame: Value) -> Result<InvocationPromise> {
        self.context
            .with(|ctx| {
                let promise: Promise = self.call(&ctx, frame)?;
                Ok(Persistent::save(&ctx, promise))
            })
            .await
    }

    pub async fn dispatch(&self, frame: Value) -> Result<()> {
        self.context.with(|ctx| self.call(&ctx, frame)).await
    }

    pub async fn check(&self, promise: &InvocationPromise) -> Result<()> {
        self.context
            .with(|ctx| {
                let promise = promise.clone().restore(&ctx)?;
                match promise.result::<()>() {
                    None => Ok(()),
                    Some(Err(error)) => Err(js_error(&ctx, error)),
                    Some(Ok(())) => Err(anyhow!("Plugin action completed without a result")),
                }
            })
            .await
    }

    fn call<'js, T: rquickjs::FromJs<'js>>(&self, ctx: &Ctx<'js>, frame: Value) -> Result<T> {
        self.dispatch
            .clone()
            .restore(ctx)
            .and_then(|dispatch| dispatch.call((frame.to_string(),)))
            .map_err(|error| js_error(ctx, error))
    }
}

async fn install_builtins(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    llrt_buffer::init(ctx)?;
    llrt_crypto::init(ctx)?;
    llrt_url::init(ctx)?;
    // Let the native exports capture their own constructors before the engine
    // installs the web globals used by fetch and its request types.
    for name in ["node:crypto", "node:url"] {
        let (_, evaluated) = crate::modules::load_builtin(ctx.clone(), name)?.eval()?;
        evaluated.into_future::<()>().await?;
    }
    Ok(())
}

pub(super) fn pending_job_error(ctx: Ctx<'_>) -> anyhow::Error {
    js_error(&ctx, rquickjs::Error::Exception)
}

fn js_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> anyhow::Error {
    match CaughtError::from_error(ctx, error) {
        CaughtError::Error(rquickjs::Error::Allocation) => anyhow!(OUT_OF_MEMORY),
        CaughtError::Exception(error) if error.message().as_deref() == Some("out of memory") => {
            anyhow!(OUT_OF_MEMORY)
        }
        // QuickJS may be too short of memory to construct its InternalError.
        CaughtError::Value(value) if value.is_null() => anyhow!(OUT_OF_MEMORY),
        error => anyhow!("{error}"),
    }
}

fn send(call: &CallOutput, line: &str) -> Result<()> {
    let Some(bridge) = &call.bridge else {
        return Ok(());
    };
    let frame: Value = serde_json::from_str(line)?;

    match frame["type"].as_str() {
        Some("op") => {
            ensure!(
                number(&frame, "call")? == call.id && call.result.borrow().is_none(),
                "stale invocation: host operation refused"
            );
            bridge.output.send(bridge.slot, frame)
        }
        Some("result") => {
            ensure!(number(&frame, "id")? == call.id, "Invalid action result id");
            if call.result.borrow().is_none() {
                call.finish(frame);
            }
            Ok(())
        }
        Some("log") => bridge.output.log(bridge.slot, frame, &bridge.logs),
        _ => anyhow::bail!("Invalid action process output"),
    }
}
