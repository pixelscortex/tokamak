use std::{
    cell::{Cell, RefCell},
    future::{Future, poll_fn},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    task::Poll,
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use rquickjs::{
    AsyncRuntime, Ctx, Exception, Module,
    loader::{ImportAttributes, Loader, Resolver},
};
use serde_json::Value;
use tokio::sync::mpsc;

use super::{
    Output,
    heap::{Heap, OUT_OF_MEMORY},
    number,
    output::LogShare,
    realm::Realm,
};
use crate::{builtins, watchdog::Watchdog};

const LOAD_TIMEOUT: Duration = Duration::from_secs(6);

pub(super) struct Bridge {
    pub slot: u64,
    pub output: Arc<Output>,
    pub next: Arc<AtomicU64>,
    pub logs: LogShare,
}

#[derive(Default)]
pub(super) struct CallOutput {
    pub id: u64,
    pub bridge: Option<Arc<Bridge>>,
    pub result: RefCell<Option<Value>>,
    pub exhausted: Rc<Cell<bool>>,
}

impl CallOutput {
    pub fn new(id: u64, bridge: Arc<Bridge>) -> Self {
        Self {
            id,
            bridge: Some(bridge),
            ..Self::default()
        }
    }

    pub fn finish(&self, frame: Value) {
        self.result.replace(Some(frame));
    }
}

pub(super) async fn run(
    source: &str,
    heap: usize,
    worker_entry: bool,
    first: Value,
    bridge: Arc<Bridge>,
    stop: Arc<AtomicBool>,
    mut receive: mpsc::UnboundedReceiver<Value>,
) -> Result<Option<Value>> {
    let output = Rc::new(CallOutput::new(number(&first, "id")?, bridge));
    let permissions: Vec<String> = serde_json::from_value(first["permissions"].clone())?;
    let network = first["network"] != false;
    let runtime = ActionRuntime::new(heap, stop, output.clone()).await?;

    let result = async {
        let realm = runtime
            .load(source, &permissions, worker_entry, network)
            .await?;
        if runtime.done() {
            return Ok(());
        }

        let promise = runtime.watched(realm.invoke(first)).await?;
        while !runtime.done() {
            tokio::select! {
                biased;
                frame = receive.recv() => {
                    let Some(frame) = frame else { break };
                    if !runtime.done() {
                        runtime.watched(realm.dispatch(frame)).await?;
                    }
                }
                result = runtime.drive(&realm, &promise) => return result,
            }
        }
        Ok(())
    }
    .await;

    // A result may have committed side effects before the last job unwinds.
    if let Some(frame) = output.result.take() {
        return Ok(Some(frame));
    }
    runtime.check_watchdog()?;
    result?;
    Ok(None)
}

pub(super) async fn inspect(source: &str, heap: usize, worker_entry: bool) -> Result<Value> {
    let runtime = ActionRuntime::new(heap, Arc::default(), Rc::new(CallOutput::default())).await?;
    let realm = runtime.load(source, &[], worker_entry, false).await?;
    Ok(realm.validators.clone())
}

struct ActionRuntime {
    runtime: AsyncRuntime,
    watchdog: Rc<Watchdog>,
    stop: Arc<AtomicBool>,
    output: Rc<CallOutput>,
}

impl ActionRuntime {
    async fn new(heap: usize, stop: Arc<AtomicBool>, output: Rc<CallOutput>) -> Result<Self> {
        // Track real allocation failures even when QuickJS cannot allocate an
        // exception object. The budget covers the arenas backing the JS heap.
        let runtime = AsyncRuntime::new_with_alloc(Heap::new(heap, output.exhausted.clone()))
            .map_err(|_| anyhow!(OUT_OF_MEMORY))?;
        runtime.set_loader(Builtins, Builtins).await;
        let watchdog = Rc::new(Watchdog::default());
        let check = watchdog.clone();
        let retired = stop.clone();
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                retired.load(Ordering::Acquire) || check.interrupt()
            })))
            .await;
        Ok(Self {
            runtime,
            watchdog,
            stop,
            output,
        })
    }

    async fn load(
        &self,
        source: &str,
        permissions: &[String],
        worker_entry: bool,
        network: bool,
    ) -> Result<Realm> {
        let result = tokio::time::timeout(
            LOAD_TIMEOUT,
            self.watched(Realm::new(
                &self.runtime,
                source,
                permissions,
                self.output.clone(),
                worker_entry,
                network,
            )),
        )
        .await;
        self.check_watchdog()?;
        result.context("Plugin action bundle initialization timed out")?
    }

    fn done(&self) -> bool {
        self.output.result.borrow().is_some()
            || self.stop.load(Ordering::Acquire)
            || self.watchdog.tripped()
    }

    fn check_watchdog(&self) -> Result<()> {
        anyhow::ensure!(
            !self.watchdog.tripped(),
            "Plugin action did not yield for 5 seconds"
        );
        Ok(())
    }

    async fn watched<T>(&self, future: impl Future<Output = T>) -> T {
        let mut future = std::pin::pin!(future);
        poll_fn(|cx| self.watchdog.poll(|| future.as_mut().poll(cx))).await
    }

    async fn drive(&self, realm: &Realm, promise: &super::realm::InvocationPromise) -> Result<()> {
        poll_fn(|cx| {
            let mut jobs = std::pin::pin!(async {
                while !self.done() {
                    match self.runtime.execute_pending_job().await {
                        Ok(true) => continue,
                        Ok(false) => {
                            realm.check(promise).await?;
                            // A pending native operation registered this waker in
                            // execute_pending_job. Control frames wake us separately.
                            return Ok(false);
                        }
                        Err(error) => {
                            if self.output.result.borrow().is_some() {
                                return Ok(true);
                            }
                            return Err(error
                                .0
                                .with(|ctx| super::realm::pending_job_error(ctx, &self.output))
                                .await);
                        }
                    }
                }
                Ok(true)
            });

            match self.watchdog.poll(|| jobs.as_mut().poll(cx)) {
                Poll::Ready(Ok(false)) | Poll::Pending => Poll::Pending,
                Poll::Ready(Ok(true)) => Poll::Ready(Ok(())),
                Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            }
        })
        .await
    }
}

struct Builtins;
impl Resolver for Builtins {
    fn resolve<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        if base == "node:path" && name == "tokamak:path" {
            return Ok(name.to_owned());
        }

        builtins::action_builtin(name)
            .map(str::to_owned)
            .ok_or_else(|| {
                Exception::throw_reference(
                    ctx,
                    &format!("Module is not allowed in the action process: {name}"),
                )
            })
    }
}

impl Loader for Builtins {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js>> {
        builtins::load_builtin(ctx.clone(), name)
    }
}
