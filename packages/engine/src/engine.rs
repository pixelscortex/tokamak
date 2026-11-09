//! QuickJS setup is independent of backend scheduling. Render owns a context
//! on its UI thread; the backend adapter builds a fresh context for each call.
//!
//! Fresh worlds deliberately trade reload cost for a simple lifecycle: no
//! leftover promise, global, or heap survives into another invocation. A limit
//! failure therefore cannot contaminate the next call on the same worker.

use crate::{Bundle, Error, Invocation, Json, Limits, OpRegistry, bridge, source_map};
use rquickjs::{
    AsyncContext, AsyncRuntime, Ctx, Function, Module, Object, Persistent, Value,
    promise::MaybePromise,
};
use std::{cell::Cell, future::Future, rc::Rc, sync::Arc, time::Instant};

/// Minimal engine boundary. JS handles never escape to callers, and the future
/// need not be Send: an engine/context belongs to the thread driving it.
pub trait Engine {
    fn invoke(
        &mut self,
        bundle: &Bundle,
        export: &str,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> impl Future<Output = Result<Json, Error>>;
}

/// Reusable thread-affine engine primitive, also used by render. No `parallel`
/// feature is enabled: the type system prevents moving JS onto another thread.
/// UI callers drive `context().async_with(...)` from their local executor and
/// can arm a deadline for each event without adopting backend pool semantics.
pub struct QuickJsContext {
    context: AsyncContext,
    runtime: AsyncRuntime,
    deadline: Rc<Cell<Option<Instant>>>,
}

impl QuickJsContext {
    pub async fn new(heap_bytes: usize) -> Result<Self, Error> {
        if heap_bytes == 0 {
            return Err(Error::InvalidInput("heap cap must be positive".into()));
        }
        let runtime = AsyncRuntime::new().map_err(|e| Error::Engine(e.to_string()))?;
        runtime.set_memory_limit(heap_bytes).await;
        let deadline = Rc::new(Cell::new(None::<Instant>));
        let interrupt = deadline.clone();
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                interrupt.get().is_some_and(|end| Instant::now() >= end)
            })))
            .await;
        let context = AsyncContext::full(&runtime).await.map_err(|e| {
            Error::Engine(format!(
                "cannot create QuickJS context within heap cap: {e}"
            ))
        })?;
        Ok(Self {
            context,
            runtime,
            deadline,
        })
    }

    pub fn context(&self) -> &AsyncContext {
        &self.context
    }

    pub fn runtime(&self) -> &AsyncRuntime {
        &self.runtime
    }

    pub fn set_deadline(&self, deadline: Option<Instant>) {
        self.deadline.set(deadline);
    }
}

/// The backend engine has configuration, not shared mutable invocation state.
/// Invoke it on a Tokio executor with time enabled (the pool supplies one).
pub struct QuickJsEngine {
    limits: Limits,
}

impl QuickJsEngine {
    pub fn new(limits: Limits) -> Result<Self, Error> {
        limits.validate()?;
        Ok(Self { limits })
    }
}

impl Engine for QuickJsEngine {
    async fn invoke(
        &mut self,
        bundle: &Bundle,
        export: &str,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<Json, Error> {
        let determinism = ops.1.unwrap_or_default();
        let load_end = Instant::now() + self.limits.load_timeout;
        let world = timed(
            load_end,
            "load",
            QuickJsContext::new(self.limits.heap_bytes),
        )
        .await?;
        world.set_deadline(Some(load_end));
        let namespace = timed(
            load_end,
            "load",
            world.context.async_with(async |ctx| {
                ctx.eval::<(), _>(determinism.bootstrap())
                    .map_err(|e| js_error(&ctx, e, bundle, false))?;
                let module = Module::declare(
                    ctx.clone(),
                    source_map::BUNDLE_NAME,
                    bundle.source.as_bytes(),
                )
                .map_err(|e| js_error(&ctx, e, bundle, true))?;
                let result = async {
                    let (module, evaluated) = module.eval()?;
                    evaluated.into_future::<()>().await?;
                    Ok::<_, rquickjs::Error>(Persistent::save(&ctx, module.namespace()?))
                }
                .await;
                result.map_err(|e| js_error(&ctx, e, bundle, false))
            }),
        )
        .await?;

        let call_end = Instant::now() + self.limits.call_timeout;
        world.set_deadline(Some(call_end));
        let mut invocation = Invocation::new(call_end);
        invocation.determinism = Some(determinism);
        let result = timed(
            call_end,
            "call",
            world.context.async_with(async |ctx| {
                let result = async {
                    let namespace: Object = namespace.restore(&ctx)?;
                    let function: Function = namespace
                        .get::<_, Value>(export)?
                        .into_function()
                        .ok_or_else(|| {
                            rquickjs::Exception::throw_type(
                                &ctx,
                                &format!("bundle export {export:?} is missing or not a function"),
                            )
                        })?;
                    let args = bridge::encode(&ctx, args)?;
                    let host = bridge::install_ops(&ctx, ops, &invocation)?;
                    // One JSON argument plus the unforgeable per-call capability.
                    // SDK's wrapper is invoke({name,args}, host); no SDK concepts
                    // need to leak into this generic exported-function primitive.
                    let pending: MaybePromise = function.call((args, host))?;
                    let value: Value = pending.into_future().await?;
                    bridge::decode(&ctx, value)
                }
                .await;
                result.map_err(|e| js_error(&ctx, e, bundle, false))
            }),
        )
        .await;
        // Retirement precedes publishing even a successful result. Async host
        // futures are not spawned elsewhere; dropping the world drops them.
        invocation.retire();
        result
    }
}

/// The interrupt stops running JS; the timer independently stops a pending
/// promise with no jobs. Check the clock after polling too: a non-yielding JS
/// call can finish after its budget before Tokio polls its timer again.
async fn timed<T>(
    end: Instant,
    phase: &'static str,
    future: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    let result = tokio::time::timeout_at(end.into(), future).await;
    if Instant::now() >= end {
        return Err(Error::Timeout { phase });
    }
    result.unwrap_or(Err(Error::Timeout { phase }))
}

fn js_error(ctx: &Ctx<'_>, error: rquickjs::Error, bundle: &Bundle, parser: bool) -> Error {
    js_error_named(ctx, error, bundle, parser, source_map::BUNDLE_NAME)
}

pub(crate) fn js_error_named(
    ctx: &Ctx<'_>,
    error: rquickjs::Error,
    bundle: &Bundle,
    parser: bool,
    name: &str,
) -> Error {
    if !error.is_exception() {
        return Error::Engine(error.to_string());
    }
    let thrown = ctx.catch();
    let message = thrown
        .as_object()
        .and_then(|o| o.get::<_, String>("message").ok())
        .or_else(|| thrown.as_string().and_then(|s| s.to_string().ok()))
        .unwrap_or_else(|| format!("JavaScript threw {thrown:?} (possibly heap cap exceeded)"));
    let stack = thrown
        .as_object()
        .and_then(|o| o.get::<_, String>("stack").ok())
        .map(|s| {
            let bounded: String = s.chars().take(32 * 1024).collect();
            source_map::remap_named(&bounded, bundle, parser, name)
        });
    // Error properties may be hostile getters; keep the same interrupt budget
    // while reading them and do not leak their exceptions into later operations.
    if ctx.has_exception() {
        ctx.catch();
    }
    Error::JavaScript { message, stack }
}
