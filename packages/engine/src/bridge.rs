//! A per-invocation capability object, never an ambient current-call global.
//!
//! A saved JS closure retains its original token. Retiring that token is final:
//! installing a bridge for another call cannot lend authority to old work.

use crate::{Determinism, Json};
use rquickjs::{Ctx, Exception, Function, Module, Object, Promise, Value, promise::MaybePromise};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

type OpResult = Result<Json, String>;

type OpFuture = Pin<Box<dyn Future<Output = OpResult> + Send>>;

enum Op {
    Sync(Box<dyn Fn(Json) -> OpResult + Send + Sync>),
    Async(Box<dyn Fn(Json) -> OpFuture + Send + Sync>),
    Module(Box<dyn Fn(Json) -> Result<ModuleCall, String> + Send + Sync>),
}

/// Native-resolved module delegation in the same world and invocation lease.
/// There is no recursive wait on the bounded pool or cross-thread JS handle.
pub struct ModuleCall {
    bundle: Arc<crate::Bundle>,
    export: String,
    args: Json,
    ops: Arc<OpRegistry>,
    on_error: Box<dyn Fn(String) + Send + Sync>,
    finished: bool,
}
impl ModuleCall {
    pub fn new(
        bundle: Arc<crate::Bundle>,
        export: impl Into<String>,
        args: Json,
        ops: Arc<OpRegistry>,
        on_error: impl Fn(String) + Send + Sync + 'static,
    ) -> Self {
        Self {
            bundle,
            export: export.into(),
            args,
            ops,
            on_error: Box::new(on_error),
            finished: false,
        }
    }
    fn finish(&mut self, error: Option<String>) {
        self.finished = true;
        if let Some(error) = error {
            (self.on_error)(error);
        }
    }
}
impl Drop for ModuleCall {
    fn drop(&mut self) {
        if !self.finished {
            (self.on_error)("delegated module operation abandoned before completion".into());
        }
    }
}

/// Construct before sharing. Per-call registries can capture the server's
/// transaction/readset without making the runtime aware of database semantics.
#[derive(Default)]
pub struct OpRegistry(BTreeMap<String, Op>, pub(crate) Option<Determinism>, Vec<String>);

impl OpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opt into replayable time and randomness for a query or mutation.
    pub fn set_determinism(&mut self, inputs: Determinism) {
        self.1 = Some(inputs);
    }

    /// Only the action engine consumes these kernel-selected grants. Grants
    /// never enable external effects in the query/mutation engine.
    pub fn set_network_permissions(&mut self, permissions: Vec<String>) {
        self.2 = permissions;
    }

    pub(crate) fn network_permissions(&self) -> Vec<String> {
        self.2.clone()
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
        self.insert(name.into(), Op::Async(Box::new(move |args| Box::pin(op(args)))))
    }

    /// Domain routing/authority belongs to the native resolver. The error
    /// observer also runs on cancellation, allowing transactional hosts to
    /// poison the outer call even when JS catches a nested exception.
    pub fn register_module(
        &mut self,
        name: impl Into<String>,
        resolver: impl Fn(Json) -> Result<ModuleCall, String> + Send + Sync + 'static,
    ) -> Result<(), crate::Error> {
        self.insert(name.into(), Op::Module(Box::new(resolver)))
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
    deadline: Option<Instant>,
    pub(crate) determinism: Option<Determinism>,
}

impl Invocation {
    pub fn new(deadline: Instant) -> Self {
        Self {
            active: Arc::new(AtomicBool::new(true)),
            deadline: Some(deadline),
            determinism: None,
        }
    }

    pub fn unbounded() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(true)),
            deadline: None,
            determinism: None,
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
    install_leased(
        ctx,
        registry,
        Lease {
            active: invocation.active.clone(),
            deadline: invocation.deadline,
            modules: Arc::new(AtomicU64::new(0)),
            depth: 0,
            determinism: invocation.determinism,
        },
    )
}

#[derive(Clone)]
struct Lease {
    active: Arc<AtomicBool>,
    deadline: Option<Instant>,
    modules: Arc<AtomicU64>,
    depth: u8,
    determinism: Option<Determinism>,
}

fn install_leased<'js>(
    ctx: &Ctx<'js>,
    registry: Arc<OpRegistry>,
    lease: Lease,
) -> rquickjs::Result<Object<'js>> {
    let host = Object::new(ctx.clone())?;
    host.set(
        "op",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, name: String, args: Value<'js>| {
            check(&ctx, &lease.active, lease.deadline)?;
            let args = decode(&ctx, args)?;
            // Serialization can run application getters, so check again immediately
            // before entering Rust, not just before converting the arguments.
            check(&ctx, &lease.active, lease.deadline)?;
            let op = registry.0.get(&name).ok_or_else(|| {
                Exception::throw_message(&ctx, &format!("unknown host op: {name}"))
            })?;
            match op {
                Op::Sync(op) => {
                    let result = op(args).map_err(|e| Exception::throw_message(&ctx, &e))?;
                    check(&ctx, &lease.active, lease.deadline)?;
                    encode(&ctx, result)
                }
                Op::Module(resolve) => {
                    let mut call =
                        resolve(args).map_err(|error| Exception::throw_message(&ctx, &error))?;
                    let number = lease.modules.fetch_add(1, Ordering::Relaxed);
                    if lease.depth >= 16 || number >= 256 {
                        call.finish(Some("delegated module depth/count budget exceeded".into()));
                        return Err(Exception::throw_message(
                            &ctx,
                            "delegated module depth/count budget exceeded",
                        ));
                    }
                    Ok(Promise::wrap_future(
                        &ctx,
                        invoke_module(ctx.clone(), call, lease.clone(), number),
                    )?
                    .into_value())
                }
                Op::Async(op) => {
                    let future = op(args);
                    Ok(Promise::wrap_future(
                        &ctx,
                        await_operation(ctx.clone(), future, lease.clone()),
                    )?
                    .into_value())
                }
            }
        })?,
    )?;
    Ok(host)
}

async fn invoke_module<'js>(
    ctx: Ctx<'js>,
    mut call: ModuleCall,
    lease: Lease,
    number: u64,
) -> rquickjs::Result<Value<'js>> {
    let name = format!("tokamak-module-{number}.js");
    let child = lease.determinism.map(|inputs| inputs.child(number));
    let source = child.map(|inputs| inputs.module_source(&call.bundle.source));
    let result = async {
        check(&ctx, &lease.active, lease.deadline)?;
        let module = Module::declare(
            ctx.clone(),
            name.as_str(),
            source.as_deref().unwrap_or(&call.bundle.source).as_bytes(),
        )
        .map_err(|error| {
            let error = crate::engine::js_error_named(&ctx, error, &call.bundle, true, &name);
            Exception::throw_message(&ctx, &error.to_string())
        })?;
        let (module, evaluated) = module.eval()?;
        evaluated.into_future::<()>().await?;
        check(&ctx, &lease.active, lease.deadline)?;
        let namespace = module.namespace()?;
        let function: Function = namespace.get(call.export.as_str())?;
        let args = encode(&ctx, call.args.clone())?;
        let host = install_leased(
            &ctx,
            call.ops.clone(),
            Lease {
                active: lease.active.clone(),
                deadline: lease.deadline,
                modules: lease.modules,
                depth: lease.depth + 1,
                determinism: child,
            },
        )?;
        let pending: MaybePromise = function.call((args, host))?;
        let result: Value = pending.into_future().await?;
        check(&ctx, &lease.active, lease.deadline)?;
        let result = decode(&ctx, result)?;
        encode(&ctx, result)
    }
    .await;
    match result {
        Ok(value) => {
            call.finish(None);
            Ok(value)
        }
        Err(error) => {
            let error =
                crate::engine::js_error_named(&ctx, error, &call.bundle, false, &name).to_string();
            call.finish(Some(error.clone()));
            Err(Exception::throw_message(&ctx, &error))
        }
    }
}

async fn await_operation<'js>(
    ctx: Ctx<'js>,
    mut future: OpFuture,
    lease: Lease,
) -> rquickjs::Result<Value<'js>> {
    // Check every poll, not just the first one. A UI
    // context can keep driving promises after the event
    // that created this operation has been retired.
    let result = std::future::poll_fn(|cx| {
        if let Err(error) = check(&ctx, &lease.active, lease.deadline) {
            return std::task::Poll::Ready(Err(error));
        }
        future
            .as_mut()
            .poll(cx)
            .map(|result| result.map_err(|e| Exception::throw_message(&ctx, &e)))
    })
    .await?;
    check(&ctx, &lease.active, lease.deadline)?;
    encode(&ctx, result)
}

fn check(ctx: &Ctx<'_>, active: &AtomicBool, deadline: Option<Instant>) -> rquickjs::Result<()> {
    if !active.load(Ordering::Acquire) || deadline.is_some_and(|end| Instant::now() >= end) {
        return Err(Exception::throw_message(ctx, "stale invocation: host operation refused"));
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
