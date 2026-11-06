//! A per-invocation capability object, never an ambient current-call global.
//!
//! A saved JS closure retains its original token. Retiring that token is final:
//! installing a bridge for another call cannot lend authority to old work.

use crate::Json;
use rquickjs::{Ctx, Exception, Function, Object, Promise, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

type OpResult = Result<Json, String>;
type OpFuture = Pin<Box<dyn Future<Output = OpResult> + Send>>;

enum Op {
    Sync(Box<dyn Fn(Json) -> OpResult + Send + Sync>),
    Async(Box<dyn Fn(Json) -> OpFuture + Send + Sync>),
}

/// Construct before sharing. Per-call registries can capture the server's
/// transaction/readset without making the runtime aware of database semantics.
#[derive(Default)]
pub struct OpRegistry(BTreeMap<String, Op>);

impl OpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sync ops must be short and nonblocking: JS interrupts cannot preempt Rust.
    /// Duplicate names are rejected rather than silently replacing capabilities.
    pub fn register_sync(
        &mut self,
        name: impl Into<String>,
        op: impl Fn(Json) -> OpResult + Send + Sync + 'static,
    ) -> Result<(), crate::Error> {
        self.insert(name.into(), Op::Sync(Box::new(op)))
    }

    /// Futures are polled on the JS worker and dropped with its world. They must
    /// yield, be cancellation-safe, and not spawn untracked side-effecting tasks.
    pub fn register_async<F, Fut>(
        &mut self,
        name: impl Into<String>,
        op: F,
    ) -> Result<(), crate::Error>
    where
        F: Fn(Json) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = OpResult> + Send + 'static,
    {
        self.insert(
            name.into(),
            Op::Async(Box::new(move |args| Box::pin(op(args)))),
        )
    }

    fn insert(&mut self, name: String, op: Op) -> Result<(), crate::Error> {
        if name.is_empty() || self.0.contains_key(&name) {
            return Err(crate::Error::InvalidInput(format!(
                "empty or duplicate host op name: {name:?}"
            )));
        }
        self.0.insert(name, op);
        Ok(())
    }
}

/// A context-bound lease. There is intentionally no reset or reactivate method.
/// Drop the owner (or explicitly retire) before publishing a call's result.
pub struct Invocation {
    active: Arc<AtomicBool>,
    deadline: Instant,
}

impl Invocation {
    pub fn new(deadline: Instant) -> Self {
        Self {
            active: Arc::new(AtomicBool::new(true)),
            deadline,
        }
    }
    pub fn retire(&self) {
        self.active.store(false, Ordering::Release);
    }
}

impl Drop for Invocation {
    fn drop(&mut self) {
        self.retire();
    }
}

/// Creates `host.op(name, args)` for one context and invocation. The caller
/// passes this object to the export; it is not reachable by module top-level code.
/// Render may use this same bridge without using the backend worker pool.
pub fn install_ops<'js>(
    ctx: &Ctx<'js>,
    registry: Arc<OpRegistry>,
    invocation: &Invocation,
) -> rquickjs::Result<Object<'js>> {
    let active = invocation.active.clone();
    let deadline = invocation.deadline;
    let host = Object::new(ctx.clone())?;
    host.set(
        "op",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, name: String, args: Value<'js>| {
                check(&ctx, &active, deadline)?;
                let args = decode(&ctx, args)?;
                // Serialization can run application getters, so check again immediately
                // before entering Rust, not just before converting the arguments.
                check(&ctx, &active, deadline)?;
                let op = registry.0.get(&name).ok_or_else(|| {
                    Exception::throw_message(&ctx, &format!("unknown host op: {name}"))
                })?;
                match op {
                    Op::Sync(op) => {
                        let result = op(args).map_err(|e| Exception::throw_message(&ctx, &e))?;
                        check(&ctx, &active, deadline)?;
                        encode(&ctx, result)
                    }
                    Op::Async(op) => {
                        let mut future = op(args);
                        let active = active.clone();
                        let future_ctx = ctx.clone();
                        Ok(Promise::wrap_future(&ctx, async move {
                            // Check every poll, not just the first one. A UI
                            // context can keep driving promises after the event
                            // that created this operation has been retired.
                            let result = std::future::poll_fn(|cx| {
                                if let Err(error) = check(&future_ctx, &active, deadline) {
                                    return std::task::Poll::Ready(Err(error));
                                }
                                future.as_mut().poll(cx).map(|result| {
                                    result.map_err(|e| Exception::throw_message(&future_ctx, &e))
                                })
                            })
                            .await?;
                            check(&future_ctx, &active, deadline)?;
                            encode(&future_ctx, result)
                        })?
                        .into_value())
                    }
                }
            },
        )?,
    )?;
    Ok(host)
}

fn check(ctx: &Ctx<'_>, active: &AtomicBool, deadline: Instant) -> rquickjs::Result<()> {
    if !active.load(Ordering::Acquire) || Instant::now() >= deadline {
        return Err(Exception::throw_message(
            ctx,
            "stale invocation: host operation refused",
        ));
    }
    Ok(())
}

pub(crate) fn decode<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<Json> {
    let text = ctx
        .json_stringify(value)?
        .ok_or_else(|| Exception::throw_type(ctx, "value is not JSON serializable"))?
        .to_string()?;
    serde_json::from_str(&text)
        .map_err(|e| Exception::throw_type(ctx, &format!("invalid JSON: {e}")))
}

pub(crate) fn encode<'js>(ctx: &Ctx<'js>, value: Json) -> rquickjs::Result<Value<'js>> {
    ctx.json_parse(value.to_string())
}
