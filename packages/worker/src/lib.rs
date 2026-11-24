//! Launch and contain the Runner and its plugin processes.
#[cfg(feature = "local-runtime")]
mod discovery;
mod logs;
mod restart;
#[cfg(feature = "local-runtime")]
pub mod runner;
mod runtime;
#[cfg(all(windows, feature = "local-runtime"))]
mod windows;

#[cfg(feature = "local-runtime")]
pub use discovery::{resolve, search_paths};
pub use logs::send as log;
pub use restart::{HEALTHY_UPTIME, RestartBackoff};
pub use runtime::configured_action_heap_bytes;
#[cfg(feature = "local-runtime")]
pub use runtime::{LocalRuntime, configured_heap_bytes};
#[cfg(any(feature = "local-runtime", not(windows)))]
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

/// Serialize macOS child creation with the socketpair-to-CLOEXEC window.
/// All Runner child launches, including the Server's device lookup, use it.
#[cfg(all(target_os = "macos", feature = "local-runtime"))]
pub fn with_spawn_lock<T>(spawn: impl FnOnce() -> T) -> T {
    static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SPAWN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    spawn()
}

#[cfg(not(windows))]
fn spawn_child(command: &mut tokio::process::Command) -> std::io::Result<Child> {
    #[cfg(all(target_os = "macos", feature = "local-runtime"))]
    return with_spawn_lock(|| command.spawn());
    #[cfg(not(all(target_os = "macos", feature = "local-runtime")))]
    command.spawn()
}

#[cfg(any(feature = "local-runtime", not(windows)))]
#[derive(Clone, Copy)]
pub enum Lane {
    Action,
    #[cfg(feature = "local-runtime")]
    Local,
}

#[cfg(any(feature = "local-runtime", not(windows)))]
impl Lane {
    fn env(self) -> (&'static str, &'static str) {
        (
            "TOKAMAK_WORKER_LANE",
            match self {
                Self::Action => "action",
                #[cfg(feature = "local-runtime")]
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
            spawn_group(command)?
        };
        Ok(Self::contained(child, containment, guardian))
    }

    #[cfg(feature = "local-runtime")]
    pub fn launch_local(
        entry: &Path,
        code: &Path,
        cwd: &Path,
        env: &BTreeMap<String, String>,
        search: &[std::path::PathBuf],
    ) -> Result<(Self, LocalRuntime), String> {
        let runtime = LocalRuntime::selected()?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if runtime == LocalRuntime::QuickJs {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let host = LocalRuntime::host_path(&executable)?;
            let mut env = env.clone();
            const HEAP_ENV: &str = "TOKAMAK_PLUGIN_HOST_HEAP_MIB";
            let heap = std::env::var_os(HEAP_ENV);
            env.remove(HEAP_ENV);
            let (child, containment, guardian) = launch(
                &host,
                None,
                code,
                cwd,
                &env,
                Lane::Local,
                heap.as_deref().map(|value| (HEAP_ENV, value)),
            )?;
            return Ok((Self::contained(child, containment, guardian), runtime));
        }

        let bun = resolve("bun", search)
            .ok_or("Local functions need Bun: install from https://bun.sh")?;
        let process = Self::launch(&bun, entry, code, cwd, env, Lane::Local)?;
        Ok((process, runtime))
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
        let host = LocalRuntime::host_path(&executable)?;
        // Darwin sets CLOEXEC in a separate syscall. While neither descriptor
        // is safe to inherit, no other Runner thread can spawn. Linux uses
        // atomic SOCK_CLOEXEC in UnixDatagram::pair.
        #[cfg(target_os = "macos")]
        let pair = with_spawn_lock(UnixDatagram::pair);
        #[cfg(target_os = "linux")]
        let pair = UnixDatagram::pair();
        let (control, native) = pair.map_err(|error| error.to_string())?;
        control
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let fd = native.as_raw_fd();
        let mut command = tokio::process::Command::new(host);
        let (lane_key, lane_value) = Lane::Local.env();
        command
            .args(["--local-plugin", plugin])
            .arg(code)
            .arg(fd.to_string())
            .env_clear()
            .envs(env)
            .env(lane_key, lane_value)
            .current_dir(cwd);
        if let Some(heap) = std::env::var_os("TOKAMAK_PLUGIN_HOST_HEAP_MIB") {
            command.env("TOKAMAK_PLUGIN_HOST_HEAP_MIB", heap);
        }
        // SAFETY: native remains open through spawn. Only this child inherits it;
        // the pre-exec callback performs an async-signal-safe fcntl.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let (child, containment, guardian) = spawn_group(command)?;
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
        Err("The action process is available on macOS and Linux".into())
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
        let (child, containment, guardian) = launch(
            host,
            mode,
            code,
            cwd,
            &BTreeMap::new(),
            Lane::Action,
            inspection.map(|options| ("TOKAMAK_ACTION_INSPECT", options)),
        )
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
        Err("The action process is available on macOS and Linux".into())
    }

    #[cfg(feature = "local-runtime")]
    pub fn launch(
        bun: &Path,
        entry: &Path,
        code: &Path,
        cwd: &Path,
        env: &BTreeMap<String, String>,
        lane: Lane,
    ) -> Result<Self, String> {
        #[cfg(windows)]
        let (child, containment, guardian) = {
            let (child, job) = windows::spawn(bun, entry, code, cwd, env, lane)
                .map_err(|error| error.to_string())?;
            (child, job, None::<Child>)
        };
        #[cfg(not(windows))]
        let (child, containment, guardian) = launch(bun, Some(entry), code, cwd, env, lane, None)?;
        Ok(Self::contained(child, containment, guardian))
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
        spawn_child(&mut command)
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
    executable: &Path,
    entry: Option<&Path>,
    code: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    lane: Lane,
    extra: Option<(&str, &std::ffi::OsStr)>,
) -> Result<(WorkerChild, Group, Option<Child>), String> {
    let mut command = tokio::process::Command::new(executable);
    command.args(entry).arg(code);
    let (lane_key, lane_value) = lane.env();
    command.env_clear().envs(env).env(lane_key, lane_value);
    if let Some((key, value)) = extra {
        command.env(key, value);
    }
    command.current_dir(cwd);
    spawn_group(command)
}

#[cfg(not(windows))]
fn spawn_group(
    mut command: tokio::process::Command,
) -> Result<(WorkerChild, Group, Option<Child>), String> {
    #[cfg(unix)]
    command.process_group(0);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = spawn_child(&mut command).map_err(|e| e.to_string())?;
    let group = Group(child.id().ok_or("Worker has no pid")?);
    let guardian = guardian(group.0)?;
    Ok((child, group, guardian))
}
