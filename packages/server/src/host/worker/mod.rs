//! Generic process actions. Database authority stays in invocation-bound ops.
mod discovery;
mod logs;
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
        Arc,
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
            bun: discovery::resolve("bun", &discovery::search_paths()),
        }))
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
        let process = process::spawn(
            &self.runtime,
            &self.id,
            bun,
            self.entry.clone(),
            self.code.clone(),
            &self.directory,
            &self.env,
        )?;
        state.process = Some(process.clone());
        // Bound restart frequency even when a broken worker exits immediately.
        state.retry = tokio::time::Instant::now() + Duration::from_millis(250);
        Ok(process)
    }
    pub(crate) async fn invoke(
        &self,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
    ) -> Result<Value, String> {
        self.invoke_with_deadline(name, args, ops, DEADLINE).await
    }
    async fn invoke_with_deadline(
        &self,
        name: String,
        args: Value,
        ops: Arc<OpRegistry>,
        deadline: Duration,
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
        if self.active {
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
