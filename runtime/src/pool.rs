//! Bounded backend scheduling. No JavaScript value crosses a worker boundary;
//! render does not use this pool because its event loop owns a persistent world.

use crate::{Bundle, Engine, Error, Json, Limits, OpRegistry, QuickJsEngine};
use std::{
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    task::{Context, Poll},
    thread,
};
use tokio::sync::oneshot;

#[derive(Clone, Debug)]
pub struct PoolConfig {
    pub workers: usize,
    /// Waiting jobs, excluding those already received by a worker. Admission
    /// never waits for room; callers must handle Overloaded explicitly.
    pub queue_capacity: usize,
    pub limits: Limits,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            workers: 2,
            queue_capacity: 32,
            limits: Limits::default(),
        }
    }
}

struct Job {
    bundle: Arc<Bundle>,
    export: String,
    args: Json,
    ops: Arc<OpRegistry>,
    reply: oneshot::Sender<Result<Json, Error>>,
}

/// Owns its worker threads. Share with Arc; dropping the last owner closes
/// admission, refuses queued jobs, and joins running workers after their budget.
/// Host callbacks must obey the cooperative/nonblocking rules on OpRegistry.
pub struct Pool {
    sender: Option<mpsc::SyncSender<Job>>,
    closing: Arc<AtomicBool>,
    threads: Vec<thread::JoinHandle<()>>,
}

impl Pool {
    pub fn new(config: PoolConfig) -> Result<Self, Error> {
        let limits = config.limits.clone();
        Self::with_engine(config, move || QuickJsEngine::new(limits.clone()))
    }

    /// Engine construction happens on each worker, so neither engines nor
    /// their futures need Send. A replacement engine leaves callers unchanged.
    pub fn with_engine<E, F>(config: PoolConfig, factory: F) -> Result<Self, Error>
    where
        E: Engine + 'static,
        F: Fn() -> Result<E, Error> + Send + Sync + 'static,
    {
        config.limits.validate()?;
        if config.workers == 0 || config.queue_capacity == 0 {
            return Err(Error::InvalidInput(
                "worker count and queue capacity must be positive".into(),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel::<Job>(config.queue_capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        let factory = Arc::new(factory);
        let mut pool = Self {
            sender: Some(sender),
            closing: Arc::new(AtomicBool::new(false)),
            threads: Vec::new(),
        };
        for id in 0..config.workers {
            let receiver = receiver.clone();
            let closing = pool.closing.clone();
            let factory = factory.clone();
            // Build the fallible executor here so startup errors reach the
            // caller, instead of returning a pool of silently dead workers.
            let executor = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .map_err(|e| Error::Engine(format!("cannot start JS executor: {e}")))?;
            let worker = thread::Builder::new()
                .name(format!("tokamak-js-{id}"))
                .spawn(move || {
                    loop {
                        // Only admission holds this lock. Execution happens after
                        // releasing it, allowing all workers to run in parallel.
                        let job = match receiver.lock() {
                            Ok(receiver) => receiver.recv(),
                            Err(_) => break,
                        };
                        let Ok(job) = job else {
                            break;
                        };
                        if closing.load(Ordering::Acquire) {
                            let _ = job.reply.send(Err(Error::Closed));
                            break;
                        }
                        let result = catch_unwind(AssertUnwindSafe(|| {
                            let mut engine = factory()?;
                            executor.block_on(engine.invoke(
                                &job.bundle,
                                &job.export,
                                job.args,
                                job.ops,
                            ))
                        }))
                        .unwrap_or_else(|_| {
                            Err(Error::Engine(
                                "JavaScript worker panicked; world discarded".into(),
                            ))
                        });
                        let _ = job.reply.send(result);
                    }
                })
                .map_err(|e| Error::Engine(format!("cannot start JS worker: {e}")))?;
            pool.threads.push(worker);
        }
        Ok(pool)
    }

    /// Immediate bounded admission. Budget starts when execution begins, not
    /// while waiting in the queue. Dropping PendingCall does not cancel a call.
    pub fn submit(
        &self,
        bundle: Arc<Bundle>,
        export: impl Into<String>,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<PendingCall, Error> {
        let (reply, receiver) = oneshot::channel();
        let job = Job {
            bundle,
            export: export.into(),
            args,
            ops,
            reply,
        };
        self.sender
            .as_ref()
            .ok_or(Error::Closed)?
            .try_send(job)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::Overloaded,
                mpsc::TrySendError::Disconnected(_) => Error::Closed,
            })?;
        Ok(PendingCall(receiver))
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::Release);
        self.sender.take();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

/// Executor-independent reply: callers can await without running on Tokio.
pub struct PendingCall(oneshot::Receiver<Result<Json, Error>>);

impl Future for PendingCall {
    type Output = Result<Json, Error>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.0).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => Poll::Ready(result.unwrap_or(Err(Error::Closed))),
        }
    }
}
