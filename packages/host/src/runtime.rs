use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    future::{Future, poll_fn},
    path::Path,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use rquickjs::{
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Exception, Function, Module, Object,
    Persistent, Promise, prelude::Func,
};
use tokamak_worker::WORKER_CAPACITY;

use crate::{
    modules,
    protocol::{DEADLINE, Output, State},
};

const HEAP_BYTES: usize = 32 * 1024 * 1024;
type Dispatch = Persistent<Function<'static>>;

pub struct Runtime {
    dispatch: Dispatch,
    context: AsyncContext,
    runtime: AsyncRuntime,
    poll_deadline: Rc<Cell<Option<Instant>>>,
}

impl Runtime {
    pub async fn new(
        code: &Path,
        state: Arc<Mutex<State>>,
        output: Arc<Output>,
        next: Rc<Cell<u64>>,
    ) -> Result<Self> {
        let code = code
            .canonicalize()
            .context("Resolving local function bundle")?;
        let bundle = code
            .to_str()
            .context("Local function bundle path is not UTF-8")?
            .to_owned();
        let runtime = AsyncRuntime::new()?;
        runtime.set_memory_limit(HEAP_BYTES).await;
        runtime
            .set_loader(modules::Resolve(bundle.clone()), modules::Load(code))
            .await;

        let poll_deadline = Rc::new(Cell::new(Some(Instant::now() + DEADLINE)));
        let limit = poll_deadline.clone();
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                limit.get().is_some_and(|end| Instant::now() >= end)
                    || state.lock().expect("protocol state").interrupt()
            })))
            .await;

        let context = AsyncContext::full(&runtime).await?;
        let dispatch = tokio::time::timeout(
            DEADLINE,
            context.async_with(async |ctx| {
                initialize(&ctx, bundle, output, next)
                    .await
                    .catch(&ctx)
                    .map_err(|error| anyhow!("{error}"))
            }),
        )
        .await
        .context("QuickJS plugin startup timed out")??;
        poll_deadline.set(None);
        Ok(Self {
            dispatch,
            context,
            runtime,
            poll_deadline,
        })
    }

    pub async fn drive(&self) {
        let mut drive = std::pin::pin!(self.runtime.drive());
        poll_fn(|cx| {
            // Timers can still run after their original call has returned.
            self.poll_deadline.set(Some(Instant::now() + DEADLINE));
            let result = drive.as_mut().poll(cx);
            self.poll_deadline.set(None);
            result
        })
        .await;
    }

    pub async fn dispatch(&self, frame: String) -> Result<()> {
        self.context
            .with(|ctx| {
                let result = self
                    .dispatch
                    .clone()
                    .restore(&ctx)
                    .and_then(|dispatch| dispatch.call((frame,)));
                result
                    .catch(&ctx)
                    .map_err(|error| anyhow!("Dispatching QuickJS frame: {error}"))
            })
            .await
    }
}

async fn initialize<'js>(
    ctx: &Ctx<'js>,
    bundle: String,
    output: Arc<Output>,
    next: Rc<Cell<u64>>,
) -> rquickjs::Result<Dispatch> {
    llrt_buffer::init(ctx)?;
    llrt_crypto::init(ctx)?;
    llrt_url::init(ctx)?;
    llrt_abort::init(ctx)?;
    llrt_stream_web::init(ctx)?;
    llrt_fetch::init(ctx)?;
    ctx.globals().set("console", Object::new(ctx.clone())?)?;
    timers(ctx)?;

    let (module, evaluated) = Module::declare(
        ctx.clone(),
        "tokamak:entry",
        include_str!(concat!(env!("OUT_DIR"), "/entry.js")),
    )?
    .eval()?;
    evaluated.into_future::<()>().await?;
    let initialize: Function = module.get("initialize")?;
    let send = Func::from(move |ctx: Ctx<'js>, line: String| {
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

fn timers<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<()> {
    let timers = Rc::new(RefCell::new(HashMap::new()));
    let active = timers.clone();
    ctx.globals().set(
        "__schedule",
        Func::from(move |ctx: Ctx<'js>, id: u32, delay: u32| {
            if active.borrow().len() >= WORKER_CAPACITY {
                return Err(Exception::throw_message(
                    &ctx,
                    "QuickJS timer capacity exceeded",
                ));
            }
            let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
            active.borrow_mut().insert(id, cancel);
            let active = active.clone();
            let (promise, resolve, _) = Promise::new(&ctx)?;
            ctx.spawn(async move {
                let fired = tokio::select! {
                    _ = cancelled => false,
                    () = tokio::time::sleep(Duration::from_millis(delay.into())) => true,
                };
                if fired {
                    active.borrow_mut().remove(&id);
                }
                let _ = resolve.call::<_, ()>((fired,));
            });
            Ok(promise)
        }),
    )?;
    ctx.globals().set(
        "__clear",
        Func::from(move |id: u32| {
            timers.borrow_mut().remove(&id);
        }),
    )?;
    ctx.eval(include_str!("timers.js"))
}
