//! Actions never borrow a transaction and never arm a time budget. An explicit
//! lifecycle cancellation can still stop both CPU-bound JS and idle host I/O.

use crate::{
    Bundle, Engine, Error, Invocation, Json, Limits, OpRegistry, QuickJsContext, bridge,
    engine::js_error_named, source_map, web,
};
use rquickjs::{Function, Module, Value, promise::MaybePromise};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct ActionEngine {
    limits: Limits,
    shutdown: CancellationToken,
}
impl ActionEngine {
    pub fn new(limits: Limits) -> Result<Self, Error> {
        Self::cancellable(limits, CancellationToken::new())
    }

    pub(crate) fn cancellable(limits: Limits, shutdown: CancellationToken) -> Result<Self, Error> {
        if limits.heap_bytes == 0 {
            return Err(Error::InvalidInput("heap cap must be positive".into()));
        }
        Ok(Self { limits, shutdown })
    }
}
impl Engine for ActionEngine {
    async fn invoke(
        &mut self,
        bundle: &Bundle,
        export: &str,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<Json, Error> {
        if ops.action_lifetime().is_cancelled() {
            return Err(Error::Engine("Plugin action cancelled by reload".into()));
        }
        if self.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        let world = QuickJsContext::new(self.limits.heap_bytes).await?;
        let stopped = self.shutdown.clone();
        let lifetime = ops.action_lifetime().clone();
        let interrupted = lifetime.clone();
        world
            .runtime()
            .set_interrupt_handler(Some(Box::new(move || {
                stopped.is_cancelled() || interrupted.is_cancelled()
            })))
            .await;
        let invocation = Invocation::unbounded();
        let web = web::WebHost::new(ops.network_permissions())?;
        let web_lease = web.lease();
        let web_ops = Arc::new(web.operations()?);
        // Module initialization is also unbounded. The only termination signals
        // on this lane are a returned value, an exception, heap exhaustion, or
        // explicit shutdown/reload; an idle 30-minute await has no deadline.
        let result = tokio::select! {
            biased;
            _ = lifetime.cancelled() => Err(Error::Closed),
            _ = self.shutdown.cancelled() => Err(Error::Closed),
            result = world.context().async_with(async |ctx| {
                let run = async {
                    let web_host = bridge::install_ops(&ctx, web_ops, &invocation)?;
                    web::install(&ctx, web_host, true)?;
                    let module = Module::declare(ctx.clone(),source_map::BUNDLE_NAME,bundle.source.as_bytes())
                        .map_err(|e| js_error_named(&ctx,e,bundle,true,source_map::BUNDLE_NAME))
                        .map_err(|e|rquickjs::Exception::throw_message(&ctx,&e.to_string()))?;
                    let (module,evaluated) = module.eval()?;
                    evaluated.into_future::<()>().await?;
                    let function: Function = module.namespace()?.get(export)?;
                    let args = bridge::encode(&ctx,args)?;
                    let host = bridge::install_ops(&ctx,ops,&invocation)?;
                    let pending: MaybePromise = function.call((args,host))?;
                    let value: Value = pending.into_future().await?;
                    bridge::decode(&ctx,value)
                }.await;
                run.map_err(|e|js_error_named(&ctx,e,bundle,false,source_map::BUNDLE_NAME))
            }) => result,
        };
        invocation.retire();
        drop(web_lease);
        if lifetime.is_cancelled() {
            return Err(Error::Engine("Plugin action cancelled by reload".into()));
        }
        if self.shutdown.is_cancelled() {
            return Err(Error::Closed);
        }
        result
    }
}
