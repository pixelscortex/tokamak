//! Generic process actions. Database authority stays in invocation-bound ops.
mod discovery;
mod logs;
pub(crate) use logs::send as server_line;
mod process;
#[cfg(windows)]
mod windows;

use crate::plugins::Asset;
use engine::OpRegistry;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const FRAME: usize = 1024 * 1024;
const GRACE: Duration = Duration::from_millis(500);
// Actions may wait for human permission for 30 minutes. This is a wall deadline,
// independent of the much shorter deterministic query/mutation CPU budget.
const DEADLINE: Duration = Duration::from_secs(60 * 60);
type Reply = oneshot::Sender<Result<Value, String>>;

enum Command {
    Invoke {
        id: u64,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
        reply: Reply,
    },
    Cancel(u64),
}
struct Process {
    commands: mpsc::Sender<Command>,
    kill: CancellationToken,
    stopped: CancellationToken,
    exit_error: OnceLock<String>,
}
struct State {
    process: Option<Arc<Process>>,
    retry: tokio::time::Instant,
}
pub(crate) struct Supervisor {
    id: String,
    entry: Arc<Asset>,
    code: Arc<Asset>,
    directory: PathBuf,
    env: BTreeMap<String, String>,
    state: Mutex<State>,
    next: AtomicU64,
    closed: CancellationToken,
    runtime: tokio::runtime::Handle,
    bun: Option<PathBuf>,
    log: OnceLock<crate::plugin_log::Log>,
}
impl Supervisor {
    pub(crate) fn new(
        id: String,
        entry: Arc<Asset>,
        code: Arc<Asset>,
        directory: PathBuf,
        environment: &Path,
        permissions: &[String],
    ) -> Result<Arc<Self>, crate::Error> {
        let mut env = BTreeMap::new();
        for name in ["PATH", "HOME", "USER", "LANG"]
            .into_iter()
            .chain(permissions.iter().filter_map(|p| p.strip_prefix("env:")))
        {
            if let Some(value) =
                crate::environment::get(name, environment).map_err(crate::Error::Invalid)?
            {
                env.insert(name.to_owned(), value);
            }
        }
        // Windows runtimes and CLI shims need system folders and user profile
        // paths even when the rest of the server environment is cleared.
        #[cfg(windows)]
        for name in [
            "SYSTEMROOT",
            "SYSTEMDRIVE",
            "COMSPEC",
            "PATHEXT",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "USERNAME",
            "HOMEDRIVE",
            "HOMEPATH",
        ] {
            if let Ok(value) = std::env::var(name) {
                env.insert(name.to_owned(), value);
            }
        }
        Ok(Arc::new(Self {
            id,
            entry,
            code,
            directory,
            env,
            state: Mutex::new(State {
                process: None,
                retry: tokio::time::Instant::now(),
            }),
            next: AtomicU64::new(0),
            closed: CancellationToken::new(),
            runtime: tokio::runtime::Handle::current(),
            log: OnceLock::new(),
            bun: discovery::resolve("bun", &discovery::search_paths()),
        }))
    }
    pub(crate) fn attach_log(&self, log: crate::plugin_log::Log) {
        let _ = self.log.set(log);
    }
    async fn process(&self) -> Result<Arc<Process>, String> {
        let mut state = self.state.lock().await;
        if self.closed.is_cancelled() {
            return Err(format!("Plugin {} worker is stopped", self.id));
        }
        if let Some(process) = &state.process {
            if !process.stopped.is_cancelled() && !process.kill.is_cancelled() {
                return Ok(process.clone());
            }
            process.stopped.cancelled().await;
            state.retry = tokio::time::Instant::now() + Duration::from_millis(250);
        }
        tokio::time::sleep_until(state.retry).await;
        if self.closed.is_cancelled() {
            return Err(format!("Plugin {} worker is stopped", self.id));
        }
        let bun = self
            .bun
            .as_ref()
            .ok_or_else(|| format!("Plugin {} needs Bun: install from https://bun.sh", self.id))?;
        std::fs::create_dir_all(&self.directory)
            .map_err(|e| format!("Plugin {} data folder: {e}", self.id))?;
        let process = process::spawn(self, bun, &self.directory, false)?;
        state.process = Some(process.clone());
        // Bound restart frequency even when a broken worker exits immediately.
        state.retry = tokio::time::Instant::now() + Duration::from_millis(250);
        Ok(process)
    }
    pub(crate) async fn check_ready(&self) -> Result<(), String> {
        let bun = self
            .bun
            .as_ref()
            .ok_or_else(|| format!("Plugin {} needs Bun", self.id))?;
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let process = process::spawn(self, bun, directory.path(), true)?;
        let _kill_on_drop = process.kill.clone().drop_guard();
        // The SDK rejects an empty function name after loading the bundle.
        // This also checks the transport for builds with an older worker entry.
        let (reply, wait) = oneshot::channel();
        let result = async {
            process
                .commands
                .try_send(Command::Invoke {
                    id: 0,
                    name: String::new(),
                    args: json!({}),
                    ops: Arc::new(OpRegistry::new()),
                    reply,
                })
                .map_err(|_| "worker closed before readiness check")?;
            match tokio::time::timeout(Duration::from_secs(10), wait).await {
                Ok(Ok(Ok(_))) => Ok(()),
                Ok(Ok(Err(error))) if error.lines().next() == Some("Unknown worker action: ") => {
                    Ok(())
                }
                Ok(Ok(Err(error))) => Err(error),
                Ok(Err(_)) => Err("worker exited before readiness check".into()),
                Err(_) => Err("worker readiness check timed out".into()),
            }
        }
        .await;
        process.kill.cancel();
        process.stopped.cancelled().await;
        result.map_err(|error| {
            let detail = process.exit_error.get().filter(|detail| !detail.is_empty());
            match detail {
                Some(detail) => format!("{error}: {detail}"),
                None => error,
            }
        })
    }

    pub(crate) async fn invoke(
        &self,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
    ) -> Result<Value, String> {
        self.invoke_with_deadline(name, args, ops, DEADLINE, None)
            .await
    }
    pub(crate) async fn invoke_nested(
        &self,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
        caller: CancellationToken,
    ) -> Result<Value, String> {
        self.invoke_with_deadline(name, args, ops, DEADLINE, Some(caller))
            .await
    }
    async fn invoke_with_deadline(
        &self,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
        deadline: Duration,
        caller: Option<CancellationToken>,
    ) -> Result<Value, String> {
        let process = self.process().await?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (reply, mut wait) = oneshot::channel();
        process
            .commands
            .try_send(Command::Invoke {
                id,
                name,
                args,
                ops,
                reply,
            })
            .map_err(|_| format!("Plugin {} worker is busy or closed", self.id))?;
        let mut lease = Lease {
            process,
            id,
            active: true,
            caller,
        };
        let result = tokio::select! {
            result = &mut wait => result.map_err(|_| format!("Plugin {} worker exited", self.id))?,
            _ = tokio::time::sleep(deadline) => {
                lease.cancel();
                let _ = wait.await;
                Err(format!("Plugin {} action deadline exceeded", self.id))
            }
        };
        lease.active = false;
        result
    }
    pub(crate) async fn stop(&self) {
        self.closed.cancel();
        let state = self.state.lock().await;
        if let Some(process) = &state.process {
            process.kill.cancel();
            process.stopped.cancelled().await;
        }
    }
}
struct Lease {
    process: Arc<Process>,
    id: u64,
    active: bool,
    caller: Option<CancellationToken>,
}
impl Lease {
    fn cancel(&self) {
        if self
            .process
            .commands
            .try_send(Command::Cancel(self.id))
            .is_err()
        {
            self.process.kill.cancel();
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        // A retired caller gives up its reply. The callee belongs to its own
        // build, so do not escalate cancellation against its worker.
        if self.active
            && !self
                .caller
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        {
            self.cancel();
        }
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        self.closed.cancel();
        if let Some(process) = &self.state.get_mut().process {
            process.kill.cancel();
        }
    }
}

#[cfg(test)]
mod tests;
