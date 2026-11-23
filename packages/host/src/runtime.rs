use std::{
    cell::Cell,
    future::{Future, poll_fn},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use rquickjs::{
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Exception, Function, Module, Object,
    Persistent, Promise, prelude::Func,
};

use crate::{
    modules::{self, Bundles},
    protocol::Output,
    timers,
};

const YIELD_LIMIT: Duration = Duration::from_secs(5);
const HEAP_ENV: &str = "TOKAMAK_PLUGIN_HOST_HEAP_MIB";

pub fn heap_bytes() -> Result<usize> {
    let Some(value) = std::env::var_os(HEAP_ENV) else {
        return Ok(256 * 1024 * 1024);
    };
    value
        .to_str()
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|mib| *mib != 0)
        .and_then(|mib| mib.checked_mul(1024 * 1024))
        .with_context(|| format!("{HEAP_ENV} must be a positive integer in MiB"))
}

#[derive(Default)]
struct Watchdog {
    deadline: Cell<Option<Instant>>,
    tripped: Cell<bool>,
}

impl Watchdog {
    fn poll<T>(&self, run: impl FnOnce() -> T) -> T {
        self.deadline.set(Some(Instant::now() + YIELD_LIMIT));
        let result = run();
        self.deadline.set(None);
        result
    }

    fn interrupt(&self) -> bool {
        if self.deadline.get().is_some_and(|end| Instant::now() >= end) {
            self.tripped.set(true);
        }
        self.tripped.get()
    }
}

type Dispatch = Persistent<Function<'static>>;

pub struct Runtime {
    dispatch: Dispatch,
    context: AsyncContext,
    runtime: AsyncRuntime,
    watchdog: Rc<Watchdog>,
}

impl Runtime {
    pub async fn new(
        bundles: Bundles,
        heap: usize,
        output: Arc<Output>,
        next: Rc<Cell<u64>>,
    ) -> Result<Self> {
        let bundle = bundles.root().to_owned();
        let runtime = AsyncRuntime::new()?;
        runtime.set_memory_limit(heap).await;
        runtime
            .set_loader(modules::Resolve(bundles.clone()), modules::Load(bundles))
            .await;

        let watchdog = Rc::new(Watchdog::default());
        let guard = watchdog.clone();
        runtime
            .set_interrupt_handler(Some(Box::new(move || guard.interrupt())))
            .await;

        let context = AsyncContext::full(&runtime).await?;
        let dispatch = {
            let startup = context.async_with(async |ctx| {
                initialize(&ctx, bundle, output, next, watchdog.clone())
                    .await
                    .catch(&ctx)
                    .map_err(|error| anyhow!("{error}"))
            });
            let mut startup = std::pin::pin!(startup);
            poll_fn(|cx| {
                let result = watchdog.poll(|| startup.as_mut().poll(cx));
                if watchdog.tripped.get() {
                    std::task::Poll::Ready(Err(anyhow!(
                        "QuickJS plugin startup did not yield for 5 seconds"
                    )))
                } else {
                    result
                }
            })
            .await?
        };
        Ok(Self {
            dispatch,
            context,
            runtime,
            watchdog,
        })
    }

    pub fn interrupted(&self) -> bool {
        self.watchdog.tripped.get()
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
) -> rquickjs::Result<Dispatch> {
    llrt_buffer::init(ctx)?;
    llrt_crypto::init(ctx)?;
    llrt_url::init(ctx)?;
    llrt_abort::init(ctx)?;
    llrt_stream_web::init(ctx)?;
    llrt_fetch::init(ctx)?;
    llrt_util::init(ctx)?;
    ctx.globals().set("console", Object::new(ctx.clone())?)?;
    timers::install(ctx)?;

    let (module, evaluated) = Module::declare(
        ctx.clone(),
        "tokamak:entry",
        include_str!(concat!(env!("OUT_DIR"), "/entry.js")),
    )?
    .eval()?;
    evaluated.into_future::<()>().await?;
    let initialize: Function = module.get("initialize")?;
    let send = Func::from(move |ctx: Ctx<'js>, line: String| {
        if watchdog.tripped.get() {
            return Ok(());
        }
        output
            .send(line)
            .map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
    });
    let next_op = Func::from(move || {
        next.set(next.get() + 1);
        next.get() as f64
    });
    let ready: Promise = initialize.call((send, next_op, bundle))?;
    Ok(Persistent::save(
        ctx,
        ready.into_future::<Function>().await?,
    ))
}
