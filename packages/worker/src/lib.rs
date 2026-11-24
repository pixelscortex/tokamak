//! Launch and contain the Runner and its plugin processes.
#[cfg(feature = "local-runtime")]
mod discovery;
mod logs;
mod restart;
#[cfg(feature = "local-runtime")]
pub mod runner;
mod runtime;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod spawn;
#[cfg(all(windows, feature = "local-runtime"))]
mod windows;

#[cfg(feature = "local-runtime")]
pub use discovery::search_paths;
pub use logs::send as log;
pub use restart::{HEALTHY_UPTIME, RestartBackoff};
#[cfg(feature = "local-runtime")]
pub use runtime::configured_heap_bytes;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
pub use runtime::require_local_host;
pub use runtime::{configured_action_heap_bytes, require_plugin_platform};
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use spawn::inherit_only;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "macos", target_os = "linux")
))]
use std::collections::BTreeMap;
use std::path::Path;
#[cfg(not(windows))]
use std::process::Stdio;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

#[cfg(all(windows, feature = "local-runtime"))]
type WorkerChild = windows::Child;
#[cfg(not(all(windows, feature = "local-runtime")))]
type WorkerChild = Child;
#[cfg(windows)]
type Containment = std::os::windows::io::OwnedHandle;
#[cfg(not(windows))]
type Containment = Group;

/// Bound protocol messages before buffering untrusted worker output.
pub const WORKER_FRAME_BYTES: usize = 1024 * 1024;
/// Bound the local worker registry and both lanes' write queues.
pub const WORKER_CAPACITY: usize = 128;

#[cfg(not(windows))]
fn spawn_child(command: &mut tokio::process::Command, keep: Option<i32>) -> std::io::Result<Child> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    inherit_only(command.as_std_mut(), keep)?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = keep;
    command.spawn()
}

pub struct Process {
    child: WorkerChild,
    containment: Option<Containment>,
    guardian: Option<Child>,
    _guardian_input: Option<ChildStdin>,
}

impl Process {
    #[cfg(feature = "local-runtime")]
    fn launch_runner(path: &Path, args: &[&std::ffi::OsStr]) -> Result<Self, String> {
        #[cfg(windows)]
        let (child, containment, guardian) = {
            let (child, job) = windows::spawn_runner(path, args).map_err(|e| e.to_string())?;
            (child, job, None)
        };
        #[cfg(not(windows))]
        let (child, containment, guardian) = {
            let mut command = tokio::process::Command::new(path);
            command.args(args);
            spawn_group(command, None)?
        };
        Ok(Self::contained(child, containment, guardian))
    }

    #[cfg(all(
        feature = "local-runtime",
        any(target_os = "macos", target_os = "linux")
    ))]
    pub fn launch_plugin(
        plugin: &str,
        code: &Path,
        cwd: &Path,
        env: &BTreeMap<String, String>,
    ) -> Result<(Self, std::os::unix::net::UnixDatagram), String> {
        use std::os::{fd::AsRawFd, unix::net::UnixDatagram};

        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let host = runtime::host_path(&executable)?;
        let (control, native) = UnixDatagram::pair().map_err(|error| error.to_string())?;
        control
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let fd = native.as_raw_fd();
        let mut command = tokio::process::Command::new(host);
        command
            .args(["--local-plugin", plugin])
            .arg(code)
            .arg(fd.to_string())
            .env_clear()
            .envs(env)
            .current_dir(cwd);
        if let Some(heap) = std::env::var_os("TOKAMAK_PLUGIN_HOST_HEAP_MIB") {
            command.env("TOKAMAK_PLUGIN_HOST_HEAP_MIB", heap);
        }
        // Native remains open through spawn. Only this child keeps it across exec.
        let (child, containment, guardian) = spawn_group(command, Some(fd))?;
        Ok((Self::contained(child, containment, guardian), control))
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn action_host_path() -> Result<std::path::PathBuf, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        // Cargo integration tests run from the target directory's deps folder.
        let executable = if executable.parent().and_then(Path::file_name) == Some("deps".as_ref()) {
            executable
                .parent()
                .ok_or("Action process executable directory missing")?
                .with_file_name("tokamak-server")
        } else {
            executable
        };
        runtime::host_path(&executable)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn action_host_path() -> Result<std::path::PathBuf, String> {
        Err(runtime::unsupported_plugin_platform(std::env::consts::OS).into())
    }

    pub fn launch_actions(host: &Path) -> Result<Self, String> {
        Self::launch_action_host(host, None, Path::new("--actions"), None)
    }

    pub fn inspect_actions(
        host: &Path,
        code: &Path,
        action: Option<(usize, bool)>,
    ) -> Result<Self, String> {
        let options = action.map(|(heap, worker_entry)| format!("{heap}:{worker_entry}"));
        Self::launch_action_host(
            host,
            Some(Path::new("--inspect-actions")),
            code,
            options.as_deref().map(std::ffi::OsStr::new),
        )
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn launch_action_host(
        host: &Path,
        mode: Option<&Path>,
        code: &Path,
        inspection: Option<&std::ffi::OsStr>,
    ) -> Result<Self, String> {
        let cwd = host
            .parent()
            .ok_or("Action process executable directory missing")?;
        let mut command = tokio::process::Command::new(host);
        command.args(mode).arg(code).env_clear().current_dir(cwd);
        if let Some(options) = inspection {
            command.env("TOKAMAK_ACTION_INSPECT", options);
        }
        let (child, containment, guardian) = spawn_group(command, None)
            .map_err(|error| format!("Launch {}: {error}", host.display()))?;
        Ok(Self::contained(child, containment, guardian))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn launch_action_host(
        _: &Path,
        _: Option<&Path>,
        _: &Path,
        _: Option<&std::ffi::OsStr>,
    ) -> Result<Self, String> {
        Err(runtime::unsupported_plugin_platform(std::env::consts::OS).into())
    }

    #[cfg(any(feature = "local-runtime", not(windows)))]
    fn contained(
        child: WorkerChild,
        containment: Containment,
        mut guardian: Option<Child>,
    ) -> Self {
        let input = guardian.as_mut().and_then(|child| child.stdin.take());
        Self {
            child,
            containment: Some(containment),
            guardian,
            _guardian_input: input,
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn pipes(&mut self) -> Result<(ChildStdin, ChildStdout, ChildStderr), String> {
        Ok((
            self.child.stdin.take().ok_or("Plugin host stdin missing")?,
            self.child
                .stdout
                .take()
                .ok_or("Plugin host stdout missing")?,
            self.child
                .stderr
                .take()
                .ok_or("Plugin host stderr missing")?,
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
            } => format!("process guardian exited ({status:?})"),
        }
    }

    pub async fn stop(&mut self) {
        drop(self.containment.take());
        #[cfg(not(all(windows, feature = "local-runtime")))]
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
            .kill_on_drop(true);
        spawn_child(&mut command, None)
            .map(Some)
            .map_err(|e| format!("Process guardian could not start: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = group;
        Ok(None)
    }
}

#[cfg(not(windows))]
fn spawn_group(
    mut command: tokio::process::Command,
    keep: Option<i32>,
) -> Result<(WorkerChild, Group, Option<Child>), String> {
    #[cfg(unix)]
    command.process_group(0);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = spawn_child(&mut command, keep).map_err(|e| e.to_string())?;
    let group = Group(child.id().ok_or("Plugin host has no PID")?);
    let guardian = guardian(group.0)?;
    Ok((child, group, guardian))
}
