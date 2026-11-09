//! UI engine adapter around engine's reusable thread-affine primitive. Every
//! entry is synchronous on the event-loop thread; only owned JSON leaves it.
use crate::{Error, Result};
use engine::{
    QuickJsContext,
    rquickjs::{CaughtError, Ctx, Function, JsLifetime, Object, Value},
};
use futures_lite::future::block_on;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::{Duration, Instant},
};

#[derive(Default)]
struct HookState {
    active: Cell<bool>,
    deadline: Cell<Option<Instant>>,
    interrupted: Cell<bool>,
    errors: RefCell<Vec<String>>,
}

impl HookState {
    fn expired(&self) -> bool {
        if self.deadline.get().is_some_and(|end| Instant::now() >= end) {
            self.interrupted.set(true);
        }
        self.interrupted.get()
    }
}

// This state owns only Rust data, with no JavaScript handles or borrowed lifetimes.
unsafe impl<'js> JsLifetime<'js> for HookState {
    type Changed<'to> = Self;
}

fn promise_callback<'js>(
    ctx: &Ctx<'js>,
    promise: Value<'js>,
    method: &str,
    invoke: impl FnOnce(Function<'js>) -> engine::rquickjs::Result<()>,
) {
    let Some(state) = ctx.userdata::<Rc<HookState>>() else {
        return;
    };
    if state.active.get() || state.expired() {
        return;
    }
    state.active.set(true);
    struct Active<'a>(&'a Cell<bool>);
    impl Drop for Active<'_> {
        fn drop(&mut self) {
            self.0.set(false);
        }
    }
    let _active = Active(&state.active);
    // QuickJS invokes AFTER with the thenable's exception still pending. Even a
    // callback which catches its own errors can consume it, so isolate the entire
    // callback/lookup/reporting sequence and restore only the saved exception.
    let pending = ctx.has_exception().then(|| ctx.catch());
    let result = (|| {
        let Some(api) = ctx.globals().get::<_, Option<Object>>("__tokamak")? else {
            return Ok(());
        };
        if let Some(callback) = api.get::<_, Option<Function>>(method)? {
            invoke(callback)?;
        }
        Ok(())
    })();
    // A void C hook cannot return the callback's interrupt. Latch the expired
    // budget, skip all later callbacks in this turn, and fail the native entry.
    // The engine's interrupt handler remains armed for the outer JS execution.
    if let Err(error) = result
        && !state.expired()
    {
        let caught = CaughtError::from_error(ctx, error);
        let message = format!("{method}: {caught}");
        // Error properties can themselves be hostile getters.
        if ctx.has_exception() {
            drop(ctx.catch());
        }
        let cause = match caught {
            CaughtError::Exception(error) => Some(error.into_value()),
            CaughtError::Value(value) => Some(value),
            CaughtError::Error(_) => None,
        };
        // Prefer the promise's captured owner. Reporting is guarded too: a
        // broken reporter cannot leak another pending exception into QuickJS.
        let reported = !state.expired()
            && cause.is_some_and(|cause| {
                (|| -> engine::rquickjs::Result<bool> {
                    let api: Object = ctx.globals().get("__tokamak")?;
                    let Some(report) = api.get::<_, Option<Function>>("promiseHookError")? else {
                        return Ok(false);
                    };
                    report.call((promise, cause))
                })()
                .unwrap_or(false)
            });
        if !reported && state.errors.borrow().len() < 16 {
            state
                .errors
                .borrow_mut()
                .push(message.chars().take(2048).collect());
        }
    }
    if ctx.has_exception() {
        drop(ctx.catch());
    }
    if let Some(pending) = pending {
        ctx.throw(pending);
    }
}

pub(crate) struct Js(QuickJsContext, Rc<HookState>);

impl Js {
    pub fn new(bundle: &str, send: Option<crate::MessageSender>) -> Result<Self> {
        // A window retains arbitrarily many plugin modules and assembles large
        // streamed assets. QuickJS cannot page its live heap or compile partial
        // functions, so a fixed window heap quota would become a product cap.
        // Use the address-space maximum rather than a fixed window quota; backend
        // invocation budgets remain separate. System allocation can still fail.
        let world = block_on(QuickJsContext::new(usize::MAX)).map_err(|e| Error(e.to_string()))?;
        let hooks = Rc::new(HookState::default());
        block_on(world.context().async_with(async |ctx| {
            ctx.store_userdata(hooks.clone())
                .map_err(|e| Error(e.to_string()))
        }))?;
        // Promise hooks retain plugin/contribution attribution even for detached
        // async functions. Rejections are delivered after jobs settle, allowing
        // ordinary .catch/try-await handlers to consume them first.
        block_on(
            world
                .runtime()
                .set_promise_hook(Some(Box::new(|ctx, kind, promise, parent| {
                    let kind = match kind {
                        engine::rquickjs::promise::PromiseHookType::Init => "init",
                        engine::rquickjs::promise::PromiseHookType::Before => "before",
                        engine::rquickjs::promise::PromiseHookType::After => "after",
                        engine::rquickjs::promise::PromiseHookType::Resolve => return,
                    };
                    // Capture-free: rquickjs 0.14 hands out &mut to this
                    // closure even on recursive hooks. State lives in userdata.
                    promise_callback(&ctx, promise.clone(), "promiseHook", |callback| {
                        callback.call((kind, promise, parent))
                    });
                }))),
        );
        block_on(
            world
                .runtime()
                .set_host_promise_rejection_tracker(Some(Box::new(
                    |ctx, promise, reason, handled| {
                        promise_callback(&ctx, promise.clone(), "promiseRejection", |callback| {
                            callback.call((promise, reason, handled))
                        });
                    },
                ))),
        );
        let end = Instant::now() + Duration::from_secs(2);
        hooks.deadline.set(Some(end));
        world.set_deadline(Some(end));
        block_on(world.context().async_with(async |ctx| {
            // Install before evaluating: initial Solid subscriptions must have
            // a valid destination, not wait for window creation or first input.
            if let Some(send) = send {
                ctx.globals()
                    .set(
                        "__tokamakSend",
                        Function::new(
                            ctx.clone(),
                            move |callback_ctx: engine::rquickjs::Ctx<'_>, message: String| {
                                send(message).map_err(|error| {
                                    engine::rquickjs::Exception::throw_message(
                                        &callback_ctx,
                                        &error.0,
                                    )
                                })
                            },
                        )
                        .map_err(|e| Error(e.to_string()))?,
                    )
                    .map_err(|e| Error(e.to_string()))?;
            }
            ctx.eval::<(), _>(bundle)
                .map_err(|e| Error(CaughtError::from_error(&ctx, e).to_string()))?;
            let api: Object = ctx
                .globals()
                .get("__tokamak")
                .map_err(|e| Error(e.to_string()))?;
            for name in ["dispatch", "host", "drain", "dispose"] {
                api.get::<_, Function>(name)
                    .map_err(|_| Error(format!("Missing UI callback {name}")))?;
            }
            Ok(())
        }))?;
        let expired = hooks.expired();
        world.set_deadline(None);
        hooks.deadline.set(None);
        let js = Self(world, hooks);
        js.report_hook_errors();
        if expired {
            return Err(Error("UI initialization deadline exceeded".into()));
        }
        Ok(js)
    }

    /// Run ready promise continuations before draining mutations. There are no
    /// UI host futures/timers to await here; idle windows are woken by HostSender.
    /// Both time and job count are bounded so a promise chain cannot starve paint.
    pub fn settle(&self) -> Result<()> {
        let end = Instant::now() + Duration::from_millis(250);
        self.arm(Some(end));
        let result = (|| {
            for _ in 0..1024 {
                if Instant::now() >= end {
                    return Err(Error("UI microtask deadline exceeded".into()));
                }
                match block_on(self.0.runtime().execute_pending_job()) {
                    Ok(false) => return Ok(()),
                    Ok(true) => {}
                    Err(error) => {
                        return Err(block_on(error.0.async_with(async |ctx| {
                            Error(
                                CaughtError::from_error(&ctx, engine::rquickjs::Error::Exception)
                                    .to_string(),
                            )
                        })));
                    }
                }
            }
            Err(Error("UI microtask budget exceeded".into()))
        })();
        self.finish_turn(result)
    }

    fn arm(&self, deadline: Option<Instant>) {
        self.1.interrupted.set(false);
        self.1.deadline.set(deadline);
        self.0.set_deadline(deadline);
    }

    fn finish_turn<T>(&self, result: Result<T>) -> Result<T> {
        let expired = self.1.expired();
        self.arm(None);
        self.report_hook_errors();
        if expired {
            Err(Error("UI JavaScript deadline exceeded".into()))
        } else {
            result
        }
    }

    fn report_hook_errors(&self) {
        for error in self.1.errors.take() {
            eprintln!("UI promise callback: {error}");
        }
    }

    pub fn call(&self, method: &str, json: Option<&str>) -> Result<Option<String>> {
        self.arm(Some(Instant::now() + Duration::from_millis(250)));
        let result = block_on(self.0.context().async_with(async |ctx| {
            let call = || -> engine::rquickjs::Result<Option<String>> {
                let api: Object = ctx.globals().get("__tokamak")?;
                // A deadline may have interrupted BEFORE/AFTER between scope
                // writes. No hook frame spans a native turn; retire that state.
                if let Some(reset) = api.get::<_, Option<Function>>("resetPromiseScope")? {
                    reset.call::<_, ()>(())?;
                }
                let function: Function = api.get(method)?;
                match method {
                    "drain" => function.call::<_, String>(()).map(Some),
                    "dispatch" => function
                        .call::<_, String>((json.unwrap_or("null"),))
                        .map(Some),
                    _ => function
                        .call::<_, ()>((json.unwrap_or("null"),))
                        .map(|()| None),
                }
            };
            call().map_err(|e| Error(CaughtError::from_error(&ctx, e).to_string()))
        }));
        self.finish_turn(result)
    }
}

impl Drop for Js {
    fn drop(&mut self) {
        if let Err(error) = self.call("dispose", None) {
            eprintln!("UI cleanup: {error}");
        }
    }
}
