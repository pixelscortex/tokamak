//! Containment for the Bun worker in both the server and the client.
mod discovery;
#[cfg(windows)]
mod windows;

pub use discovery::{resolve, search_paths};
#[cfg(not(windows))]
use std::process::Stdio;
use std::{collections::BTreeMap, path::Path};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

#[cfg(windows)]
type WorkerChild = windows::Child;
#[cfg(not(windows))]
type WorkerChild = Child;
#[cfg(windows)]
type Containment = std::os::windows::io::OwnedHandle;
#[cfg(not(windows))]
type Containment = Group;

/// Bound protocol messages before buffering untrusted worker output.
pub const WORKER_FRAME_BYTES: usize = 1024 * 1024;
/// Bound the local worker registry and both lanes' write queues.
pub const WORKER_CAPACITY: usize = 128;

#[derive(Clone, Copy)]
pub enum Lane {
    Action,
    Local,
}

impl Lane {
    fn env(self) -> (&'static str, &'static str) {
        (
            "TOKAMAK_WORKER_LANE",
            match self {
                Self::Action => "action",
                Self::Local => "local",
            },
        )
    }
}

pub struct Process {
    child: WorkerChild,
    containment: Option<Containment>,
    guardian: Option<Child>,
    _guardian_input: Option<ChildStdin>,
}

impl Process {
    pub fn launch(
        bun: &Path,
        entry: &Path,
        code: &Path,
        cwd: &Path,
        env: &BTreeMap<String, String>,
        lane: Lane,
    ) -> Result<Self, String> {
        #[cfg(windows)]
        let (child, containment, mut guardian) = {
            let (child, job) = windows::spawn(bun, entry, code, cwd, env, lane)
                .map_err(|error| error.to_string())?;
            (child, job, None::<Child>)
        };
        #[cfg(not(windows))]
        let (child, containment, mut guardian) = launch(bun, entry, code, cwd, env, lane)?;
        let input = guardian.as_mut().and_then(|child| child.stdin.take());
        Ok(Self {
            child,
            containment: Some(containment),
            guardian,
            _guardian_input: input,
        })
    }

    pub fn pipes(&mut self) -> Result<(ChildStdin, ChildStdout, ChildStderr), String> {
        Ok((
            self.child.stdin.take().ok_or("Worker stdin missing")?,
            self.child.stdout.take().ok_or("Worker stdout missing")?,
            self.child.stderr.take().ok_or("Worker stderr missing")?,
        ))
    }

    pub async fn exited(&mut self) -> String {
        tokio::select! {
            status = self.child.wait() => format!("process exited ({status:?})"),
            status = async {
                match self.guardian.as_mut() {
                    Some(child) => child.wait().await,
                    None => std::future::pending().await,
                }
            } => format!("worker guardian exited ({status:?})"),
        }
    }

    pub async fn stop(&mut self) {
        drop(self.containment.take());
        #[cfg(not(windows))]
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        if let Some(mut guardian) = self.guardian.take() {
            let _ = guardian.wait().await;
        }
    }
}

#[cfg(not(windows))]
struct Group(u32);
#[cfg(not(windows))]
impl Drop for Group {
    fn drop(&mut self) {
        // The worker and its ordinary descendants inherit this group. Local
        // programs have their own watchdogs for their separate groups.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

#[cfg(not(windows))]
fn guardian(group: u32) -> Result<Option<Child>, String> {
    #[cfg(unix)]
    {
        // stdin is a private liveness pipe. Only the parent holds its write end;
        // EOF works even if the worker's JS event loop is blocked indefinitely.
        let mut command = tokio::process::Command::new("/bin/sh");
        command.process_group(group as i32);
        command.args(["-c", "trap '' TERM; while IFS= read -r line; do :; done; kill -TERM -\"$1\" 2>/dev/null; /bin/sleep 0.2; kill -KILL -\"$1\" 2>/dev/null", "worker-guardian", &group.to_string()]);
        command
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map(Some)
            .map_err(|e| format!("Worker guardian could not start: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = group;
        Ok(None)
    }
}

#[cfg(not(windows))]
fn launch(
    bun: &Path,
    entry: &Path,
    code: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    lane: Lane,
) -> Result<(WorkerChild, Group, Option<Child>), String> {
    let mut command = tokio::process::Command::new(bun);
    #[cfg(unix)]
    command.process_group(0);
    command.arg(entry).arg(code);
    let (lane_key, lane_value) = lane.env();
    let child = command
        .env_clear()
        .envs(env)
        .env(lane_key, lane_value)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let group = Group(child.id().ok_or("Worker has no pid")?);
    let guardian = guardian(group.0)?;
    Ok((child, group, guardian))
}
