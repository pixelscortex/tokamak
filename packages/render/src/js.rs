//! UI engine adapter around engine's reusable thread-affine primitive. Every
//! entry is synchronous on the event-loop thread; only owned JSON leaves it.
use crate::{Error, Result};
use engine::{
    QuickJsContext,
    rquickjs::{CaughtError, Function, Object},
};
use futures_lite::future::block_on;
use std::time::{Duration, Instant};

pub(crate) struct Js(QuickJsContext);

impl Js {
    pub fn new(bundle: &str, send: Option<crate::MessageSender>) -> Result<Self> {
        let world =
            block_on(QuickJsContext::new(64 * 1024 * 1024)).map_err(|e| Error(e.to_string()))?;
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
                    if let Ok(api) = ctx.globals().get::<_, Object>("__tokamak") {
                        if let Ok(callback) = api.get::<_, Function>("promiseHook") {
                            let _ = callback.call::<_, ()>((kind, promise, parent));
                        }
                    }
                }))),
        );
        block_on(
            world
                .runtime()
                .set_host_promise_rejection_tracker(Some(Box::new(
                    |ctx, promise, reason, handled| {
                        if let Ok(api) = ctx.globals().get::<_, Object>("__tokamak") {
                            if let Ok(callback) = api.get::<_, Function>("promiseRejection") {
                                let _ = callback.call::<_, ()>((promise, reason, handled));
                            }
                        }
                    },
                ))),
        );
        world.set_deadline(Some(Instant::now() + Duration::from_secs(2)));
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
        world.set_deadline(None);
        Ok(Self(world))
    }

    /// Run ready promise continuations before draining mutations. There are no
    /// UI host futures/timers to await here; idle windows are woken by HostSender.
    /// Both time and job count are bounded so a promise chain cannot starve paint.
    pub fn settle(&self) -> Result<()> {
        let end = Instant::now() + Duration::from_millis(250);
        self.0.set_deadline(Some(end));
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
        self.0.set_deadline(None);
        result
    }

    pub fn call(&self, method: &str, json: Option<&str>) -> Result<Option<String>> {
        self.0
            .set_deadline(Some(Instant::now() + Duration::from_millis(250)));
        let result = block_on(self.0.context().async_with(async |ctx| {
            let call = || -> engine::rquickjs::Result<Option<String>> {
                let api: Object = ctx.globals().get("__tokamak")?;
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
        self.0.set_deadline(None);
        result
    }
}

impl Drop for Js {
    fn drop(&mut self) {
        if let Err(error) = self.call("dispose", None) {
            eprintln!("UI cleanup: {error}");
        }
    }
}
