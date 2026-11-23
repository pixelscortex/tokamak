//! Server-owned admission, cancellation and restart policy for the action process.
mod inspection;
mod transport;

pub(crate) use inspection::inspect_legacy;

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use arc_swap::ArcSwapOption;
use engine::{Bundle, OpRegistry};
use serde_json::{Value, json};
use tokamak_worker::WORKER_CAPACITY;
use tokio::{
    runtime::Handle,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::plugins::Asset;

const DEADLINE: Duration = Duration::from_secs(3600);
const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
const PLUGIN_CAPACITY: usize = WORKER_CAPACITY / 2;
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
    worker_entry: bool,
    retired: CancellationToken,
    calls: Arc<Semaphore>,
    operations: Arc<Semaphore>,
}

impl Source {
    pub(crate) fn plugin(
        name: &str,
        code: Arc<Asset>,
        bundle: Arc<Bundle>,
        worker_entry: bool,
    ) -> Arc<Self> {
        Self::new(name.into(), Snapshot::Artifact(code), bundle, worker_entry)
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

    fn new(name: String, code: Snapshot, bundle: Arc<Bundle>, worker_entry: bool) -> Arc<Self> {
        Arc::new(Self {
            name,
            slot: NEXT_SLOT.fetch_add(1, Ordering::Relaxed) + 1,
            code,
            bundle,
            worker_entry,
            retired: CancellationToken::new(),
            calls: Arc::new(Semaphore::new(PLUGIN_CAPACITY)),
            operations: Arc::new(Semaphore::new(PLUGIN_CAPACITY)),
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
    slot: u64,
    source: Arc<Source>,
    frame: Value,
    ops: Arc<OpRegistry>,
    reply: oneshot::Sender<Result<Value, String>>,
    active: CancellationToken,
    _permit: OwnedSemaphorePermit,
    _plugin_permit: OwnedSemaphorePermit,
    _cancel_on_drop: tokio_util::sync::DropGuard,
}

struct Running {
    commands: mpsc::UnboundedSender<Command>,
    stop: CancellationToken,
    ended: CancellationToken,
    stopped_at: OnceLock<Instant>,
    #[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
    pid: u32,
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

#[derive(Clone, Copy)]
struct Timing {
    ping: Duration,
    unresponsive: Duration,
    healthy: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ping: Duration::from_secs(10),
            unresponsive: Duration::from_secs(30),
            healthy: HEALTHY_UPTIME,
        }
    }
}

pub(crate) struct InvocationOptions {
    pub(crate) timeout: Duration,
    pub(crate) anonymous: bool,
}

impl Default for InvocationOptions {
    fn default() -> Self {
        Self {
            timeout: DEADLINE,
            anonymous: false,
        }
    }
}

pub(crate) struct Supervisor {
    runtime: Handle,
    restart: Mutex<Restart>,
    current: ArcSwapOption<Running>,
    closed: CancellationToken,
    slots: Arc<Semaphore>,
    next: AtomicU64,
    heap: usize,
    host: PathBuf,
    timing: Timing,
}

impl Supervisor {
    pub(crate) fn new(host: PathBuf, heap: usize) -> Arc<Self> {
        Self::with_timing(host, heap, Timing::default())
    }

    fn with_timing(host: PathBuf, heap: usize, timing: Timing) -> Arc<Self> {
        Arc::new(Self {
            runtime: Handle::current(),
            restart: Mutex::default(),
            current: ArcSwapOption::empty(),
            closed: CancellationToken::new(),
            slots: Arc::new(Semaphore::new(WORKER_CAPACITY)),
            next: AtomicU64::new(0),
            heap,
            host,
            timing,
        })
    }

    async fn process(&self) -> Result<Arc<Running>, String> {
        loop {
            let mut restart = self.restart.lock().await;
            if self.closed.is_cancelled() {
                return Err("Action process stopped".into());
            }

            if let Some(process) = self.current.load_full() {
                if !process.stop.is_cancelled()
                    && !process.ended.is_cancelled()
                    && !process.commands.is_closed()
                {
                    return Ok(process);
                }
                if !process.ended.is_cancelled() {
                    let ended = process.ended.clone();
                    drop(restart);
                    ended.cancelled().await;
                    continue;
                }
                let stopped = process
                    .stopped_at
                    .get()
                    .copied()
                    .unwrap_or_else(Instant::now);
                let healthy = stopped.duration_since(process.started) >= self.timing.healthy;
                restart.failed(stopped, healthy);
                self.current.store(None);
            }

            if let Some(retry) = restart.retry_at.filter(|retry| *retry > Instant::now()) {
                drop(restart);
                tokio::select! {
                    () = self.closed.cancelled() => return Err("Action process stopped".into()),
                    () = tokio::time::sleep_until(retry) => {}
                }
                continue;
            }

            match transport::start(&self.runtime, &self.host, self.timing) {
                Ok(process) => {
                    self.current.store(Some(process.clone()));
                    return Ok(process);
                }
                Err(error) => {
                    restart.failed(Instant::now(), false);
                    return Err(error);
                }
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
        self.invoke_with(source, name, args, ops, InvocationOptions::default())
            .await
    }

    pub(crate) async fn invoke_with(
        &self,
        source: Arc<Source>,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
        options: InvocationOptions,
    ) -> Result<Value, String> {
        let plugin_permit = source.calls.clone().try_acquire_owned().map_err(|_| {
            format!(
                "Plugin {} reached its action call limit ({PLUGIN_CAPACITY})",
                source.name
            )
        })?;
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Action process invocation capacity exceeded")?;
        let end = Instant::now() + options.timeout;
        let process = tokio::select! {
            biased;
            () = source.retired.cancelled() => return Err("Plugin action cancelled by reload".into()),
            () = tokio::time::sleep_until(end) => return Err("Plugin action deadline exceeded".into()),
            result = self.process() => result?,
        };
        let slot = if options.anonymous {
            NEXT_SLOT.fetch_add(1, Ordering::Relaxed) + 1
        } else {
            source.slot
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let frame = json!({
            "type":"invoke","slot":slot,"id":id,"fn":name,"args":args,"pluginName":source.name,
            "path":source.path(),"workerEntry":source.worker_entry,"heap":self.heap,
            "permissions":ops.network_permissions(),"network":!options.anonymous,
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
                slot,
                source: source.clone(),
                frame,
                ops,
                reply,
                active: active.clone(),
                _permit: permit,
                _plugin_permit: plugin_permit,
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
            () = tokio::time::sleep_until(end) => return Err("Plugin action deadline exceeded".into()),
            result = result => result.map_err(|_| "Action process exited before replying")?,
        };
        lease.armed = false;
        result
    }

    pub(crate) fn retire(&self, source: &Source) {
        source.retired.cancel();
        if let Some(process) = self.current.load_full() {
            let _ = process.commands.send(Command::Retire(source.slot));
        }
    }

    pub(crate) async fn stop(&self) {
        self.closed.cancel();
        let process = {
            let _launch = self.restart.lock().await;
            self.current.load_full()
        };
        if let Some(process) = process {
            process.stop.cancel();
            process.ended.cancelled().await;
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        if let Some(process) = self.current.load_full() {
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

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod process_tests;
