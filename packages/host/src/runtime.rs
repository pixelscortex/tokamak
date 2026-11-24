use std::{
    cell::Cell,
    future::{Future, poll_fn},
    rc::Rc,
    sync::Arc,
};

use anyhow::{Result, anyhow};
use rquickjs::{
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Exception, Function, Module, Object,
    Persistent, Promise,
    prelude::{Async, Func},
};

use crate::{
    modules::{self, Bundle},
    programs::Programs,
    protocol::Output,
    timers,
    watchdog::Watchdog,
};

const HEAP_ENV: &str = "TOKAMAK_PLUGIN_HOST_HEAP_MIB";

pub fn heap_bytes() -> Result<usize> {
    tokamak_worker::configured_heap_bytes(HEAP_ENV).map_err(anyhow::Error::msg)
}

type Dispatch = Persistent<Function<'static>>;

pub struct Runtime {
    dispatch: Dispatch,
    context: AsyncContext,
    runtime: AsyncRuntime,
    watchdog: Rc<Watchdog>,
    pub programs: Programs,
    pub immediates: timers::Immediates,
}

impl Runtime {
    pub async fn new_local(
        bundle_file: Bundle,
        heap: usize,
        output: Arc<Output>,
        next: Rc<Cell<u64>>,
        programs: Programs,
    ) -> Result<Self> {
        let bundle = bundle_file.root().to_owned();
        let runtime = AsyncRuntime::new()?;
        runtime.set_memory_limit(heap).await;
        runtime
            .set_loader(
                modules::Resolve(bundle_file.clone()),
                modules::Load(bundle_file),
            )
            .await;

        let watchdog = Rc::new(Watchdog::default());
        let guard = watchdog.clone();
        runtime
            .set_interrupt_handler(Some(Box::new(move || guard.interrupt())))
            .await;

        let context = AsyncContext::full(&runtime).await?;
        let immediates = timers::Immediates::default();
        let dispatch = {
            let startup = context.async_with(async |ctx| {
                // Only local functions receive process; action workers must not expose it.
                install_process_env(&ctx)
                    .catch(&ctx)
                    .map_err(|error| anyhow!("{error}"))?;

                initialize(
                    &ctx,
                    bundle,
                    output,
                    next,
                    watchdog.clone(),
                    &programs,
                    immediates.clone(),
                )
                .await
                .catch(&ctx)
                .map_err(|error| anyhow!("{error}"))
            });
            let mut startup = std::pin::pin!(startup);
            poll_fn(|cx| {
                let result = watchdog.poll(|| startup.as_mut().poll(cx));
                if watchdog.tripped() {
                    return std::task::Poll::Ready(Err(anyhow!(
                        "QuickJS plugin startup did not yield for 5 seconds"
                    )));
                }
                // Top-level imports can await an immediate before the
                // protocol loop takes over the scheduler.
                if result.is_pending() && immediates.pending() {
                    immediates.fire();
                    cx.waker().wake_by_ref();
                }
                result
            })
            .await?
        };
        Ok(Self {
            dispatch,
            context,
            runtime,
            watchdog,
            programs,
            immediates,
        })
    }

    pub fn interrupted(&self) -> bool {
        self.watchdog.tripped()
    }

    pub async fn drive(&self) {
        let mut drive = std::pin::pin!(self.runtime.drive());
        poll_fn(|cx| {
            let result = self.watchdog.poll(|| drive.as_mut().poll(cx));
            if self.interrupted() {
                std::task::Poll::Ready(())
            } else {
                result
            }
        })
        .await;
    }

    pub async fn dispatch(&self, frame: String) -> Result<()> {
        let dispatch = self.context.with(|ctx| {
            self.dispatch
                .clone()
                .restore(&ctx)
                .and_then(|dispatch| dispatch.call((frame,)))
                .catch(&ctx)
                .map_err(|error| anyhow!("Dispatching QuickJS frame: {error}"))
        });
        let mut dispatch = std::pin::pin!(dispatch);
        poll_fn(|cx| self.watchdog.poll(|| dispatch.as_mut().poll(cx))).await
    }
}

async fn initialize<'js>(
    ctx: &Ctx<'js>,
    bundle: String,
    output: Arc<Output>,
    next: Rc<Cell<u64>>,
    watchdog: Rc<Watchdog>,
    programs: &Programs,
    immediates: timers::Immediates,
) -> rquickjs::Result<Dispatch> {
    llrt_buffer::init(ctx)?;
    llrt_crypto::init(ctx)?;
    llrt_url::init(ctx)?;
    llrt_abort::init(ctx)?;
    llrt_stream_web::init(ctx)?;
    llrt_fetch::init(ctx)?;
    llrt_util::init(ctx)?;
    ctx.globals().set("console", Object::new(ctx.clone())?)?;
    timers::install(ctx, immediates)?;

    let (module, evaluated) = Module::declare(
        ctx.clone(),
        "tokamak:entry",
        include_str!(concat!(env!("OUT_DIR"), "/entry.js")),
    )?
    .eval()?;
    evaluated.into_future::<()>().await?;
    let initialize: Function = module.get("initialize")?;
    let waiting_output = output.clone();
    let waiting_watchdog = watchdog.clone();
    let send_wait = Func::from(Async(move |ctx: Ctx<'js>, line: String| {
        let output = waiting_output.clone();
        let watchdog = waiting_watchdog.clone();
        async move {
            if watchdog.tripped() {
                return Ok(());
            }
            output
                .send_wait(line)
                .await
                .map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
        }
    }));
    let try_send = Func::from(move |ctx: Ctx<'js>, line: String| {
        if watchdog.tripped() {
            return Ok(true);
        }
        output
            .try_send(line)
            .map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
    });
    let next_op = Func::from(move || {
        next.set(next.get() + 1);
        next.get() as f64
    });
    let ready: Promise =
        initialize.call((try_send, send_wait, next_op, bundle, programs.factory(ctx)?))?;
    Ok(Persistent::save(
        ctx,
        ready.into_future::<Function>().await?,
    ))
}

fn install_process_env(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let process = Object::new(ctx.clone())?;
    let env = Object::new(ctx.clone())?;
    // The launcher has already limited which variables enter the worker.
    for (name, value) in std::env::vars_os() {
        env.prop(
            name.to_string_lossy().as_ref(),
            rquickjs::object::Property::from(value.to_string_lossy().as_ref())
                .writable()
                .enumerable()
                .configurable(),
        )?;
    }
    process.set("env", env)?;
    process.set("pid", std::process::id())?;
    process.set(
        "platform",
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
    )?;
    process.set("versions", Object::new(ctx.clone())?)?;

    ctx.globals().set("process", process)
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.programs.stop_all();
    }
}
