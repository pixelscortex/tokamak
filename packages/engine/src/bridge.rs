//! A per-invocation capability object, never an ambient current-call global.
//!
//! A saved JS closure retains its original token. Retiring that token is final:
//! installing a bridge for another call cannot lend authority to old work.

use crate::{Determinism, Json};
use rquickjs::{
    Class, Ctx, Exception, Function, Module, Object, Promise, Value, promise::MaybePromise,
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    future::Future,
    pin::Pin,
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Instant,
};

pub type CallFuture<'a> = Pin<Box<dyn Future<Output = Result<Json, CallError>> + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallLimit {
    Depth,
    Modules,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
    pub message: String,
    pub details: Option<Json>,
    pub limit: Option<CallLimit>,
}

impl From<&str> for CallError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl From<String> for CallError {
    fn from(message: String) -> Self {
        Self {
            message,
            details: None,
            limit: None,
        }
    }
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}

impl From<crate::Error> for CallError {
    fn from(error: crate::Error) -> Self {
        match error {
            crate::Error::Call(error) => error,
            other => other.to_string().into(),
        }
    }
}

#[derive(Clone, Default)]
pub struct HookBudget {
    used: Arc<AtomicUsize>,
    attempt: Option<Arc<AtomicUsize>>,
}

impl HookBudget {
    pub fn take(&self) -> bool {
        if self
            .used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                (count < 256).then_some(count + 1)
            })
            .is_err()
        {
            return false;
        }
        if let Some(attempt) = &self.attempt {
            attempt.fetch_add(1, Ordering::Relaxed);
        }
        true
    }

    pub fn attempt(&self) -> Self {
        Self {
            used: self.used.clone(),
            attempt: Some(Arc::default()),
        }
    }

    pub fn refund_attempt(&self) {
        if let Some(attempt) = &self.attempt {
            self.used
                .fetch_sub(attempt.swap(0, Ordering::Relaxed), Ordering::Relaxed);
        }
    }
}

pub trait StageExecutor {
    /// Enter a stage whose delegated calls share the stage budget.
    fn run(&self, call: ModuleCall, budget: HookBudget) -> CallFuture<'_>;
}

pub trait CallTransforms: Send + Sync {
    fn before<'a>(&'a self, executor: &'a dyn StageExecutor, input: Json) -> CallFuture<'a>;
    fn after<'a>(
        &'a self,
        executor: &'a dyn StageExecutor,
        input: Json,
        value: Json,
    ) -> CallFuture<'a>;
}

type OpResult = Result<Json, String>;

type OpFuture = Pin<Box<dyn Future<Output = OpResult> + Send>>;
type StructuredOpFuture = Pin<Box<dyn Future<Output = Result<Json, CallError>> + Send>>;
type CompleteModule = Box<dyn FnOnce(Json) -> OpFuture + Send>;
type OpenModule = Pin<Box<dyn Future<Output = Result<CompleteModule, String>> + Send>>;

type StagedOperation = dyn for<'a> Fn(&'a dyn StageExecutor, Json) -> CallFuture<'a> + Send + Sync;

enum Op {
    Sync(Box<dyn Fn(Json) -> OpResult + Send + Sync>),
    Async(Box<dyn Fn(Json) -> OpFuture + Send + Sync>),
    Call(Box<dyn Fn(Json) -> StructuredOpFuture + Send + Sync>),
    Module(Box<dyn Fn(Json) -> Result<ModuleCall, CallError> + Send + Sync>),
    Staged(Arc<StagedOperation>),
}

/// Native-resolved module delegation in the same world and invocation lease.
/// There is no recursive wait on the bounded pool or cross-thread JS handle.
pub struct ModuleCall {
    bundle: Arc<crate::Bundle>,
    export: String,
    args: Json,
    ops: Arc<OpRegistry>,
    on_error: Box<dyn Fn(CallError) + Send + Sync>,
    scope: Option<OpenModule>,
    finished: bool,
    catch_structured: bool,
}
impl ModuleCall {
    pub fn new(
        bundle: Arc<crate::Bundle>,
        export: impl Into<String>,
        args: Json,
        ops: Arc<OpRegistry>,
        on_error: impl Fn(CallError) + Send + Sync + 'static,
    ) -> Self {
        Self {
            bundle,
            export: export.into(),
            args,
            ops,
            on_error: Box::new(on_error),
            scope: None,
            finished: false,
            catch_structured: false,
        }
    }

    /// Hold native state across a child call and finalize it before publishing the result.
    /// Exceptions and abandoned calls still notify `on_error`.
    pub fn with_scope<S, F>(
        mut self,
        open: impl Future<Output = Result<S, String>> + Send + 'static,
        complete: impl FnOnce(S, Json) -> F + Send + 'static,
    ) -> Self
    where
        S: Send + 'static,
        F: Future<Output = OpResult> + Send + 'static,
    {
        self.scope = Some(Box::pin(async move {
            let state = open.await?;
            let complete: CompleteModule = Box::new(move |value| Box::pin(complete(state, value)));
            Ok(complete)
        }));
        self
    }

    /// A read-only call can propagate a structured failure without poisoning the caller.
    pub fn catch_structured(mut self) -> Self {
        self.catch_structured = true;
        self
    }

    fn finish(&mut self, error: Option<CallError>) {
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
pub struct OpRegistry(
    BTreeMap<String, Op>,
    pub(crate) Option<Determinism>,
    Vec<String>,
    pub(crate) Option<Arc<dyn CallTransforms>>,
);

impl OpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opt into replayable time and randomness for a query or mutation.
    pub fn set_determinism(&mut self, inputs: Determinism) {
        self.1 = Some(inputs);
    }

    pub fn with_transforms(mut self, transforms: impl CallTransforms + 'static) -> Self {
        self.3 = Some(Arc::new(transforms));
        self
    }

    /// Only the action engine consumes these kernel-selected grants. Grants
    /// never enable external effects in the query/mutation engine.
    pub fn set_network_permissions(&mut self, permissions: Vec<String>) {
        self.2 = permissions;
    }

    pub fn network_permissions(&self) -> Vec<String> {
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
        self.insert(
            name.into(),
            Op::Async(Box::new(move |args| Box::pin(op(args)))),
        )
    }

    /// Run an operation that may invoke transaction stages in the current world.
    pub fn register_staged(
        &mut self,
        name: impl Into<String>,
        op: impl for<'a> Fn(&'a dyn StageExecutor, Json) -> CallFuture<'a> + Send + Sync + 'static,
    ) -> Result<(), crate::Error> {
        self.insert(name.into(), Op::Staged(Arc::new(op)))
    }

    pub(crate) fn may_run_stages(&self) -> bool {
        self.0
            .values()
            .any(|op| matches!(op, Op::Staged(_) | Op::Module(_)))
    }

    pub fn register_call<F, Fut>(
        &mut self,
        name: impl Into<String>,
        op: F,
    ) -> Result<(), crate::Error>
    where
        F: Fn(Json) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Json, CallError>> + Send + 'static,
    {
        self.insert(
            name.into(),
            Op::Call(Box::new(move |args| Box::pin(op(args)))),
        )
    }

    /// Domain routing/authority belongs to the native resolver. The error
    /// observer also runs on cancellation, allowing transactional hosts to
    /// poison the outer call even when JS catches a nested exception.
    pub fn register_module(
        &mut self,
        name: impl Into<String>,
        resolver: impl Fn(Json) -> Result<ModuleCall, String> + Send + Sync + 'static,
    ) -> Result<(), crate::Error> {
        self.register_module_call(name, move |args| resolver(args).map_err(Into::into))
    }

    pub fn register_module_call(
        &mut self,
        name: impl Into<String>,
        resolver: impl Fn(Json) -> Result<ModuleCall, CallError> + Send + Sync + 'static,
    ) -> Result<(), crate::Error> {
        self.insert(name.into(), Op::Module(Box::new(resolver)))
    }

    /// Dispatch an action's existing capabilities from a process transport.
    /// Module operations belong to transactional QuickJS worlds, not actions.
    pub async fn dispatch(&self, name: &str, args: Json) -> OpResult {
        self.dispatch_call(name, args)
            .await
            .map_err(|error| error.message)
    }

    pub async fn dispatch_call(&self, name: &str, args: Json) -> Result<Json, CallError> {
        match self.0.get(name) {
            Some(Op::Sync(op)) => op(args).map_err(Into::into),
            Some(Op::Async(op)) => op(args).await.map_err(Into::into),
            Some(Op::Call(op)) => op(args).await,
            _ => Err(format!("unknown action host op: {name}").into()),
        }
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
    install_leased(ctx, registry, Lease::root(invocation), Weak::new())
}

#[derive(Clone)]
struct Lease {
    active: Arc<AtomicBool>,
    deadline: Option<Instant>,
    modules: HookBudget,
    sequence: Arc<AtomicU64>,
    depth: u8,
    determinism: Option<Determinism>,
}

impl Lease {
    fn root(invocation: &Invocation) -> Self {
        Self {
            active: invocation.active.clone(),
            deadline: invocation.deadline,
            modules: HookBudget::default(),
            sequence: Arc::default(),
            depth: 0,
            determinism: invocation.determinism,
        }
    }
}

// The evaluated namespace and its lexical random stream belong to this world.
type StageModules<'js> = RefCell<HashMap<*const crate::Bundle, EvaluatedStage<'js>>>;

#[derive(Clone)]
struct EvaluatedStage<'js> {
    name: String,
    namespace: Object<'js>,
    ready: Promise<'js>,
    _bundle: Arc<crate::Bundle>,
}

struct Executor<'js> {
    ctx: Ctx<'js>,
    lease: Lease,
    stages: Weak<StageModules<'js>>,
}

impl StageExecutor for Executor<'_> {
    fn run(&self, call: ModuleCall, budget: HookBudget) -> CallFuture<'_> {
        let mut lease = self.lease.clone();
        lease.modules = budget;
        Box::pin(invoke_module(
            self.ctx.clone(),
            call,
            lease,
            self.stages.clone(),
            true,
        ))
    }
}

pub(crate) async fn invoke_export<'js>(
    ctx: &Ctx<'js>,
    invocation: &Invocation,
    ops: Arc<OpRegistry>,
    function: Function<'js>,
    args: Json,
    bundle: &crate::Bundle,
) -> Result<Json, crate::Error> {
    let stages = Rc::new(StageModules::default());
    let executor = Executor {
        ctx: ctx.clone(),
        lease: Lease::root(invocation),
        stages: Rc::downgrade(&stages),
    };
    execute_export(
        &executor,
        ops,
        function,
        args,
        bundle,
        crate::source_map::BUNDLE_NAME,
    )
    .await
    .map_err(crate::Error::Call)
}

async fn execute_export<'js>(
    executor: &Executor<'js>,
    ops: Arc<OpRegistry>,
    function: Function<'js>,
    mut args: Json,
    bundle: &crate::Bundle,
    name: &str,
) -> Result<Json, CallError> {
    if let Some(transforms) = &ops.3 {
        args = transforms.before(executor, args).await?;
    }
    let ctx = &executor.ctx;
    let result = async {
        check(ctx, &executor.lease.active, executor.lease.deadline)?;
        let args = encode(ctx, args.clone())?;
        let host = install_leased(
            ctx,
            ops.clone(),
            executor.lease.clone(),
            executor.stages.clone(),
        )?;
        let pending: MaybePromise = function.call((args, host))?;
        let value: Value = pending.into_future().await?;
        check(ctx, &executor.lease.active, executor.lease.deadline)?;
        decode(ctx, value)
    }
    .await
    .map_err(|error| module_error(ctx, error, bundle, name))?;

    match &ops.3 {
        Some(transforms) => transforms.after(executor, args, result).await,
        None => Ok(result),
    }
}

fn install_leased<'js>(
    ctx: &Ctx<'js>,
    registry: Arc<OpRegistry>,
    lease: Lease,
    stages: Weak<StageModules<'js>>,
) -> rquickjs::Result<Object<'js>> {
    let host = Object::new(ctx.clone())?;
    host.set(
        "op",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, name: String, args: Value<'js>| {
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
                        let call = resolve(args).map_err(|error| throw_call(&ctx, error))?;
                        let lease = lease.clone();
                        let ctx = ctx.clone();
                        let stages = stages.clone();
                        Ok(Promise::wrap_future(&ctx.clone(), async move {
                            let result = invoke_module(ctx.clone(), call, lease, stages, false)
                                .await
                                .map_err(|error| throw_call(&ctx, error))?;
                            encode(&ctx, result)
                        })?
                        .into_value())
                    }
                    Op::Staged(op) => {
                        let op = op.clone();
                        let executor = Executor {
                            ctx: ctx.clone(),
                            lease: lease.clone(),
                            stages: stages.clone(),
                        };
                        Ok(
                            Promise::wrap_future(&ctx, await_staged(executor, op, args))?
                                .into_value(),
                        )
                    }
                    Op::Call(_) => Err(Exception::throw_message(
                        &ctx,
                        "operation requires an action process",
                    )),
                    Op::Async(op) => {
                        let future = op(args);
                        Ok(Promise::wrap_future(
                            &ctx,
                            await_operation(ctx.clone(), future, lease.clone()),
                        )?
                        .into_value())
                    }
                }
            },
        )?,
    )?;
    Ok(host)
}

async fn invoke_module<'js>(
    ctx: Ctx<'js>,
    mut call: ModuleCall,
    mut lease: Lease,
    stages: Weak<StageModules<'js>>,
    is_stage: bool,
) -> Result<Json, CallError> {
    let limit = if lease.depth >= 16 {
        Some(CallLimit::Depth)
    } else if !is_stage && !lease.modules.take() {
        Some(CallLimit::Modules)
    } else {
        None
    };
    if let Some(limit) = limit {
        let message = "delegated module depth/count budget exceeded".to_owned();
        let error = CallError {
            message,
            details: None,
            limit: Some(limit),
        };
        call.finish(Some(error.clone()));
        return Err(error);
    }

    let number = lease.sequence.fetch_add(1, Ordering::Relaxed);
    let name = format!("tokamak-module-{number}.js");
    lease.depth += 1;
    lease.determinism = lease.determinism.map(|inputs| inputs.child(number));
    let result = async {
        let complete = match call.scope.take() {
            Some(open) => Some(open.await.map_err(CallError::from)?),
            None => None,
        };
        check(&ctx, &lease.active, lease.deadline)
            .map_err(|error| module_error(&ctx, error, &call.bundle, &name))?;
        let cached = is_stage.then(|| stages.upgrade()).flatten();
        let module = load_module(
            &ctx,
            &call.bundle,
            name,
            lease.determinism,
            cached.as_deref(),
        )?;
        module
            .ready
            .into_future::<()>()
            .await
            .map_err(|error| module_error(&ctx, error, &call.bundle, &module.name))?;
        let function = module
            .namespace
            .get::<_, Function>(call.export.as_str())
            .map_err(|error| module_error(&ctx, error, &call.bundle, &module.name))?;
        let executor = Executor { ctx, lease, stages };
        let value = execute_export(
            &executor,
            call.ops.clone(),
            function,
            call.args.clone(),
            &call.bundle,
            &module.name,
        )
        .await?;
        match complete {
            Some(complete) => complete(value).await.map_err(CallError::from),
            None => Ok(value),
        }
    }
    .await;

    let poison = result
        .as_ref()
        .err()
        .filter(|error| !call.catch_structured || error.details.is_none())
        .cloned();
    call.finish(poison);
    result
}

fn load_module<'js>(
    ctx: &Ctx<'js>,
    bundle: &Arc<crate::Bundle>,
    name: String,
    determinism: Option<Determinism>,
    cache: Option<&StageModules<'js>>,
) -> Result<EvaluatedStage<'js>, CallError> {
    let key = Arc::as_ptr(bundle);
    if let Some(module) = cache.and_then(|cache| cache.borrow().get(&key).cloned()) {
        return Ok(module);
    }
    let source = determinism.map(|inputs| inputs.module_source(&bundle.source));
    let module = Module::declare(
        ctx.clone(),
        name.as_str(),
        source.as_deref().unwrap_or(&bundle.source).as_bytes(),
    )
    .map_err(|error| crate::engine::js_error_named(ctx, error, bundle, true, &name))?;
    let (module, ready) = module
        .eval()
        .map_err(|error| module_error(ctx, error, bundle, &name))?;
    let namespace = module
        .namespace()
        .map_err(|error| module_error(ctx, error, bundle, &name))?;
    let module = EvaluatedStage {
        name,
        namespace,
        ready,
        _bundle: bundle.clone(),
    };
    if let Some(cache) = cache {
        cache.borrow_mut().insert(key, module.clone());
    }
    Ok(module)
}

#[derive(rquickjs::class::Trace, rquickjs::JsLifetime)]
#[rquickjs::class]
struct NativeCallError {
    #[qjs(skip_trace)]
    error: CallError,
}

pub(crate) fn native_call_error(object: &Object<'_>) -> Option<CallError> {
    let carrier = object.get::<_, Object>("callDetails").ok()?;
    let native = Class::<NativeCallError>::from_object(&carrier)?;
    Some(native.borrow().error.clone())
}

fn throw_call(ctx: &Ctx<'_>, error: CallError) -> rquickjs::Error {
    let result = Exception::from_message(ctx.clone(), &error.message).and_then(|exception| {
        if let Some(details) = &error.details {
            let value = encode(ctx, details.clone())?;
            if let Some(fields) = value.as_object() {
                for key in ["plugin", "hook", "stage", "kind", "data", "table"] {
                    exception
                        .as_object()
                        .set(key, fields.get::<_, Value>(key)?)?;
                }
            }
        }
        if error.details.is_some() || error.limit.is_some() {
            exception.as_object().set(
                "callDetails",
                Class::instance(ctx.clone(), NativeCallError { error })?,
            )?;
        }
        Ok(exception.throw())
    });
    result.unwrap_or_else(|error| error)
}

fn module_error(
    ctx: &Ctx<'_>,
    error: rquickjs::Error,
    bundle: &crate::Bundle,
    name: &str,
) -> CallError {
    crate::engine::js_error_named(ctx, error, bundle, false, name).into()
}

async fn await_staged<'js>(
    executor: Executor<'js>,
    op: Arc<StagedOperation>,
    args: Json,
) -> rquickjs::Result<Value<'js>> {
    let Executor { ctx, lease, .. } = &executor;
    let mut future = op(&executor, args);
    let result = std::future::poll_fn(|cx| {
        check(ctx, &lease.active, lease.deadline)?;
        future
            .as_mut()
            .poll(cx)
            .map(|result| result.map_err(|e| throw_call(ctx, e)))
    })
    .await?;
    check(ctx, &lease.active, lease.deadline)?;
    encode(ctx, result)
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
