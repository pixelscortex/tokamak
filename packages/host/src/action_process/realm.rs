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
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Exception, Function, Module, Object,
    Persistent, prelude::Func,
};
use serde_json::Value;
use tokio::sync::mpsc;

use super::{
    BUNDLE, number,
    plugin::{Active, Bridge},
};
use crate::runtime::Watchdog;

pub(super) struct Config {
    pub bridge: Rc<Bridge>,
    pub watchdog: Rc<Watchdog>,
    pub active: Active,
    pub completed: mpsc::UnboundedSender<u64>,
}

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
        config: Config,
        node_modules: bool,
        network: bool,
    ) -> Result<Self> {
        let web = WebHost::new(permissions.to_vec())?;
        let lease = web.lease();
        let operations = Arc::new(web.operations()?);
        let context = AsyncContext::full(runtime).await?;
        let invocation = Invocation::unbounded();
        let dispatch = context
            .async_with(async |ctx| {
                let run = async {
                    // Full Node module support is needed for the bundle originally built for Bun.
                    // Default bundles are portable and get a fresh realm for each invocation.
                    if node_modules {
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
                    let next = config.bridge.next.clone();
                    let send = Function::new(ctx.clone(), move |ctx: Ctx<'_>, line: String| {
                        send(&config, &line)
                            .map_err(|e| Exception::throw_message(&ctx, &e.to_string()))
                    })?;
                    logging.call::<_, ()>((send.clone(),))?;
                    let (module, evaluated) =
                        Module::declare(ctx.clone(), BUNDLE, source.as_bytes())?.eval()?;
                    evaluated.into_future::<()>().await?;
                    let functions: Object = module.get("functions")?;
                    let next_op =
                        Func::from(move || (next.fetch_add(1, Ordering::Relaxed) + 1) as f64);
                    let dispatch: Function = initialize.call((send, next_op, functions))?;
                    Ok::<_, rquickjs::Error>(Persistent::save(&ctx, dispatch))
                }
                .await;
                run.catch(&ctx).map_err(|error| anyhow!("{error}"))
            })
            .await?;

        Ok(Self {
            dispatch,
            context,
            _web: lease,
            _web_invocation: invocation,
        })
    }

    pub async fn dispatch(&self, frame: Value) -> Result<()> {
        self.context
            .with(|ctx| {
                self.dispatch
                    .clone()
                    .restore(&ctx)
                    .and_then(|dispatch| dispatch.call((frame.to_string(),)))
                    .catch(&ctx)
                    .map_err(|error| anyhow!("{error}"))
            })
            .await
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

fn send(config: &Config, line: &str) -> Result<()> {
    if config.watchdog.tripped() {
        return Ok(());
    }
    let frame: Value = serde_json::from_str(line)?;
    let slot = config.bridge.slot;
    let output = &config.bridge.output;

    match frame["type"].as_str() {
        Some("op") => {
            let id = number(&frame, "call")?;
            ensure!(
                config.active.borrow().contains(&id),
                "stale invocation: host operation refused"
            );
            output.send(slot, frame)
        }
        Some("result") => {
            let id = number(&frame, "id")?;
            if config.active.borrow().contains(&id) {
                output.send(slot, frame)?;
                config.active.borrow_mut().remove(&id);
                let _ = config.completed.send(id);
            }
            Ok(())
        }
        Some("log") => output.log(slot, frame, &config.bridge.logs),
        _ => anyhow::bail!("Invalid action process output"),
    }
}
