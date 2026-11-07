//! UI engine adapter around runtime's reusable thread-affine primitive. Every
//! entry is synchronous on the event-loop thread; only owned JSON leaves it.
use crate::{Error, Result};
use futures_lite::future::block_on;
use runtime::{
    QuickJsContext,
    rquickjs::{CaughtError, Function, Object},
};
use std::time::{Duration, Instant};

pub(crate) struct Js(QuickJsContext);

impl Js {
    pub fn new(bundle: &str, send: Option<crate::MessageSender>) -> Result<Self> {
        let world =
            block_on(QuickJsContext::new(64 * 1024 * 1024)).map_err(|e| Error(e.to_string()))?;
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
                            move |callback_ctx: runtime::rquickjs::Ctx<'_>, message: String| {
                                send(message).map_err(|error| {
                                    runtime::rquickjs::Exception::throw_message(
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
                                CaughtError::from_error(&ctx, runtime::rquickjs::Error::Exception)
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
            let call = || -> runtime::rquickjs::Result<Option<String>> {
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
