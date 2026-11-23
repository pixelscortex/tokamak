//! Server-owned admission, cancellation and restart policy for the action process.
mod transport;

use std::{
    io::Write,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use engine::{Bundle, OpRegistry};
use serde_json::{Value, json};
use tokamak_worker::WORKER_CAPACITY;
use tokio::{
    runtime::Handle,
    sync::{Mutex, Semaphore, mpsc, oneshot},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::plugins::Asset;

const DEADLINE: Duration = Duration::from_secs(3600);
const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
const BASE_DELAY: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(30);
static NEXT_SLOT: AtomicU64 = AtomicU64::new(0);

enum Snapshot {
    Artifact(Arc<Asset>),
    Legacy(tempfile::NamedTempFile),
}

pub(crate) struct Source {
    name: String,
    slot: u64,
    code: Snapshot,
    bundle: Arc<Bundle>,
    persistent: bool,
    retired: CancellationToken,
}

impl Source {
    pub(crate) fn plugin(
        name: &str,
        code: Arc<Asset>,
        bundle: Arc<Bundle>,
        persistent: bool,
    ) -> Arc<Self> {
        Self::new(name.into(), Snapshot::Artifact(code), bundle, persistent)
    }

    pub(crate) fn legacy(bundle: Arc<Bundle>) -> Result<Arc<Self>, crate::Error> {
        let mut file = tempfile::NamedTempFile::new()
            .map_err(|error| crate::Error::Invalid(error.to_string()))?;
        file.write_all(bundle.source().as_bytes())
            .map_err(|error| crate::Error::Invalid(error.to_string()))?;
        Ok(Self::new(
            "legacy".into(),
            Snapshot::Legacy(file),
            bundle,
            false,
        ))
    }

    fn new(name: String, code: Snapshot, bundle: Arc<Bundle>, persistent: bool) -> Arc<Self> {
        Arc::new(Self {
            name,
            slot: NEXT_SLOT.fetch_add(1, Ordering::Relaxed) + 1,
            code,
            bundle,
            persistent,
            retired: CancellationToken::new(),
        })
    }

    fn path(&self) -> &Path {
        match &self.code {
            Snapshot::Artifact(code) => code.path(),
            Snapshot::Legacy(file) => file.path(),
        }
    }
}

enum Command {
    Invoke(Box<Call>),
    Cancel(u64),
    Retire(u64),
}

struct Call {
    id: u64,
    source: Arc<Source>,
    frame: Value,
    ops: Arc<OpRegistry>,
    reply: oneshot::Sender<Result<Value, String>>,
    active: CancellationToken,
    _permit: tokio::sync::OwnedSemaphorePermit,
    _cancel_on_drop: tokio_util::sync::DropGuard,
}

struct Running {
    commands: mpsc::UnboundedSender<Command>,
    stop: CancellationToken,
    ended: CancellationToken,
    healthy: AtomicBool,
    started: Instant,
}

#[derive(Default)]
struct Restart {
    failures: u32,
    retry_at: Option<Instant>,
}

impl Restart {
    fn failed(&mut self, now: Instant, healthy: bool) {
        if healthy {
            self.failures = 0;
        }
        let delay = BASE_DELAY
            .saturating_mul(1 << self.failures.min(7))
            .min(MAX_DELAY);
        self.failures = self.failures.saturating_add(1);
        self.retry_at = Some(now + delay);
    }
}

#[derive(Default)]
struct State {
    process: Option<Arc<Running>>,
    restart: Restart,
}

pub(crate) struct Supervisor {
    runtime: Handle,
    state: Mutex<State>,
    closed: CancellationToken,
    slots: Arc<Semaphore>,
    next: AtomicU64,
    heap: usize,
}

impl Supervisor {
    pub(crate) fn new(heap: usize) -> Arc<Self> {
        Arc::new(Self {
            runtime: Handle::current(),
            state: Mutex::default(),
            closed: CancellationToken::new(),
            slots: Arc::new(Semaphore::new(WORKER_CAPACITY)),
            next: AtomicU64::new(0),
            heap,
        })
    }

    async fn process(&self) -> Result<Arc<Running>, String> {
        let mut state = self.state.lock().await;
        if self.closed.is_cancelled() {
            return Err("Action process stopped".into());
        }
        if let Some(process) = &state.process {
            if !process.stop.is_cancelled()
                && !process.ended.is_cancelled()
                && !process.commands.is_closed()
            {
                return Ok(process.clone());
            }
            process.ended.cancelled().await;
            let healthy = process.healthy.load(Ordering::Acquire);
            state.restart.failed(Instant::now(), healthy);
            state.process = None;
        }
        if let Some(retry) = state.restart.retry_at {
            tokio::select! {
                () = self.closed.cancelled() => return Err("Action process stopped".into()),
                () = tokio::time::sleep_until(retry) => {}
            }
        }
        let started = transport::start(&self.runtime);
        match started {
            Ok(process) => {
                state.process = Some(process.clone());
                Ok(process)
            }
            Err(error) => {
                state.restart.failed(Instant::now(), false);
                Err(error)
            }
        }
    }

    pub(crate) async fn invoke(
        &self,
        source: Arc<Source>,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
    ) -> Result<Value, String> {
        self.invoke_with_web(source, name, args, ops, true).await
    }

    pub(crate) async fn invoke_anonymous(
        &self,
        source: Arc<Source>,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
    ) -> Result<Value, String> {
        self.invoke_with_web(source, name, args, ops, false).await
    }

    async fn invoke_with_web(
        &self,
        source: Arc<Source>,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
        network: bool,
    ) -> Result<Value, String> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Action process invocation capacity exceeded")?;
        let end = tokio::time::Instant::now() + DEADLINE;
        let process = tokio::select! {
            biased;
            () = source.retired.cancelled() => return Err("Plugin action cancelled by reload".into()),
            result = self.process() => result?,
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let frame = json!({
            "type":"invoke","slot":source.slot,"id":id,"fn":name,"args":args,
            "path":source.path(),"persistent":source.persistent,"heap":self.heap,
            "permissions":ops.network_permissions(),"network":network,
        });
        if super::worker::process::oversized(&frame)? {
            return Err("Worker invocation exceeds 1 MiB limit".into());
        }
        let (reply, result) = oneshot::channel();
        let active = CancellationToken::new();
        process
            .commands
            .send(Command::Invoke(Box::new(Call {
                id,
                source: source.clone(),
                frame,
                ops,
                reply,
                active: active.clone(),
                _permit: permit,
                _cancel_on_drop: active.clone().drop_guard(),
            })))
            .map_err(|_| "Action process exited before invocation")?;

        let mut lease = Lease {
            id,
            active,
            process,
            armed: true,
        };
        let result = tokio::select! {
            biased;
            () = source.retired.cancelled() => return Err("Plugin action cancelled by reload".into()),
            result = result => result.map_err(|_| "Action process exited before replying")?,
            () = tokio::time::sleep_until(end) => return Err("Plugin action deadline exceeded".into()),
        };
        lease.armed = false;
        result
    }

    pub(crate) async fn retire(&self, source: &Source) {
        source.retired.cancel();
        if let Some(process) = &self.state.lock().await.process {
            let _ = process.commands.send(Command::Retire(source.slot));
        }
    }

    pub(crate) async fn stop(&self) {
        self.closed.cancel();
        if let Some(process) = &self.state.lock().await.process {
            process.stop.cancel();
            process.ended.cancelled().await;
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        if let Some(process) = &self.state.get_mut().process {
            process.stop.cancel();
        }
    }
}

struct Lease {
    id: u64,
    active: CancellationToken,
    process: Arc<Running>,
    armed: bool,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.armed {
            self.active.cancel();
            let _ = self.process.commands.send(Command::Cancel(self.id));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_delay_grows_caps_and_resets_after_health() {
        let now = Instant::now();
        let mut restart = Restart::default();
        for expected in [250, 500, 1000] {
            restart.failed(now, false);
            assert_eq!(
                restart.retry_at,
                Some(now + Duration::from_millis(expected))
            );
        }
        for _ in 0..10 {
            restart.failed(now, false);
        }
        assert_eq!(restart.retry_at, Some(now + MAX_DELAY));
        restart.failed(now, true);
        assert_eq!(restart.retry_at, Some(now + BASE_DELAY));
    }
}
