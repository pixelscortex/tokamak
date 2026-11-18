mod command;

use command::server_command;
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use reqwest::{Url, blocking::Client};
use serde::{Deserialize, Serialize};
use tauri::Manager;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Serialize)]
pub struct Endpoint {
    http: String,
    ws: String,
    token: Option<String>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Identity {
    pid: u32,
    url: String,
    bundle_hash: String,
    build_id: Option<String>,
    plugin_root: Option<PathBuf>,
}

#[derive(Default)]
pub struct Host(Mutex<()>);

#[tauri::command]
pub async fn tokamak_endpoint(
    app: tauri::AppHandle,
    host: tauri::State<'_, Host>,
) -> std::result::Result<Endpoint, String> {
    let _ = host;
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<Host>();
        let _guard = host.0.lock().map_err(|e| e.to_string())?;
        ensure(&app).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn binary() -> Result<PathBuf> {
    if cfg!(debug_assertions) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
        for profile in ["debug", "release"] {
            let path = root
                .join(profile)
                .join(format!("tokamak{}", std::env::consts::EXE_SUFFIX));
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    let path =
        std::env::current_exe()?.with_file_name(format!("tokamak{}", std::env::consts::EXE_SUFFIX));
    if !path.is_file() {
        return Err("Tokamak server binary is missing; run the app preparation script".into());
    }
    Ok(path)
}

fn token(directory: &Path) -> Result<String> {
    let path = directory.join("server.token");
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() {
        return Err("Local capability must be a private regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Local capability must be private (chmod 600)".into());
        }
    }
    let value = fs::read_to_string(path)?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid local capability".into());
    }
    Ok(value)
}

fn discovery_url(identity: &Identity) -> Result<Url> {
    let url = Url::parse(&identity.url)?;
    if identity.pid == 0
        || identity.bundle_hash.len() != 64
        || !identity.bundle_hash.bytes().all(|b| b.is_ascii_hexdigit())
        || url.scheme() != "ws"
        || url.path() != "/ws"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url
            .host_str()
            .ok_or("Missing host")?
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()?
            .is_loopback()
    {
        return Err("Invalid local server discovery".into());
    }
    Ok(url)
}

enum Status {
    Offline,
    Reuse(Endpoint),
    Replace(Identity),
}

// No shutdown or signal is permitted until discovery and health agree. In
// particular, an old server without a build id still has to pass this check.
fn reuse_decision(
    identity: &Identity,
    actual: &Identity,
    plugins: &Path,
    build: &str,
) -> Result<bool> {
    if actual != identity {
        return Err("Local server identity does not match discovery".into());
    }
    // A server started from another installation (a dev checkout, an older app)
    // owns the same data folder, so it is replaced like any other stale build.
    Ok(identity.plugin_root.as_deref() == Some(plugins)
        && identity.build_id.as_deref() == Some(build))
}

fn status(client: &Client, directory: &Path, plugins: &Path, build: &str) -> Result<Status> {
    let bytes = match fs::read(directory.join("server.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Status::Offline),
        Err(error) => return Err(error.into()),
    };
    let identity: Identity = serde_json::from_slice(&bytes)?;
    let mut url = discovery_url(&identity)?;
    let capability = token(directory)?;
    url.set_scheme("http").map_err(|_| "Invalid scheme")?;
    url.set_path("/health");
    let response = match client.get(url.clone()).bearer_auth(&capability).send() {
        Ok(response) => response.error_for_status()?,
        Err(_) => return Ok(Status::Offline),
    };
    let actual: Identity = serde_json::from_slice(&response.bytes()?)?;
    if !reuse_decision(&identity, &actual, plugins, build)? {
        return Ok(Status::Replace(identity));
    }
    url.set_path("");
    Ok(Status::Reuse(Endpoint {
        http: url.to_string().trim_end_matches('/').to_owned(),
        ws: identity.url,
        token: Some(capability),
    }))
}

fn stop(client: &Client, directory: &Path, identity: &Identity) -> Result<()> {
    let process = LocalProcess::open(identity.pid)?;
    let capability = token(directory)?;
    let mut url = discovery_url(identity)?;
    url.set_scheme("http").map_err(|_| "Invalid scheme")?;
    url.set_path("/shutdown");
    // status() verified this exact process while holding the startup lock.
    // A lost response can mean that graceful shutdown already closed HTTP I/O.
    let _ = client.post(url.clone()).bearer_auth(&capability).send();
    let graceful_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < graceful_deadline {
        if process.exited()? {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    let fallback = terminate_verified(client, url, &capability, identity, &process);
    #[cfg(windows)]
    let fallback: Result<()> = Err("SIGTERM fallback is unavailable on Windows".into());
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if process.exited()? {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    let detail = fallback
        .err()
        .map(|error| format!("; {error}"))
        .unwrap_or_default();
    Err(format!("Old local server did not exit after shutdown{detail}; inspect server.log").into())
}

#[cfg(unix)]
fn terminate_verified(
    client: &Client,
    mut url: Url,
    capability: &str,
    identity: &Identity,
    process: &LocalProcess,
) -> Result<()> {
    // Never signal on the strength of a stale discovery file alone. If
    // shutdown has closed health but not exited, report it without signaling.
    url.set_path("/health");
    let actual = client
        .get(url)
        .bearer_auth(capability)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|e| {
            format!("Old local server has not exited; cannot verify identity for SIGTERM: {e}")
        })?;
    let actual: Identity = serde_json::from_slice(&actual.bytes()?)?;
    if &actual != identity {
        return Err("Local server identity changed before SIGTERM; refusing to signal".into());
    }
    process.terminate()
}

#[cfg(unix)]
struct LocalProcess(libc::pid_t);

#[cfg(unix)]
impl LocalProcess {
    fn open(pid: u32) -> Result<Self> {
        let pid = libc::pid_t::try_from(pid)?;
        if pid <= 0 {
            return Err("Invalid local server pid".into());
        }
        Ok(Self(pid))
    }

    fn exited(&self) -> Result<bool> {
        // The server may be our own child from a previous window. Reap it so
        // a zombie does not look alive forever to the existence probe below.
        let mut status = 0;
        let waited = unsafe { libc::waitpid(self.0, &mut status, libc::WNOHANG) };
        if waited == self.0 {
            return Ok(true);
        }
        if waited < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ECHILD) {
                return Err(error.into());
            }
        }
        // Signal zero only checks existence; it does not deliver a signal.
        if unsafe { libc::kill(self.0, 0) } == 0 {
            return Ok(false);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(true)
        } else {
            Err(error.into())
        }
    }

    fn terminate(&self) -> Result<()> {
        if unsafe { libc::kill(self.0, libc::SIGTERM) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
struct LocalProcess(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl LocalProcess {
    fn open(pid: u32) -> Result<Self> {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(handle))
    }

    fn exited(&self) -> Result<bool> {
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::WaitForSingleObject,
        };
        match unsafe { WaitForSingleObject(self.0, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(std::io::Error::last_os_error().into()),
        }
    }
}

#[cfg(windows)]
impl Drop for LocalProcess {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

struct LaunchLock(PathBuf);
impl Drop for LaunchLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn ensure_token(directory: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(directory.join("server.token")) {
        Ok(mut file) => {
            use std::io::Write;
            write!(
                file,
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    token(directory)?;
    Ok(())
}

fn server_log(directory: &Path) -> Result<fs::File> {
    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    Ok(log_options.open(directory.join("server.log"))?)
}

fn server_metadata(binary: &Path) -> Result<(String, PathBuf)> {
    let output = server_command(binary).arg("--build-id").output()?;
    let build = String::from_utf8(output.stdout)?.trim().to_owned();
    if !output.status.success()
        || build.len() != 64
        || !build.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Cannot determine local server build identity".into());
    }
    let output = server_command(binary).arg("--local-path").output()?;
    if !output.status.success() {
        return Err("Cannot discover local server directory".into());
    }
    Ok((
        build,
        PathBuf::from(String::from_utf8(output.stdout)?.trim()),
    ))
}

fn ensure(app: &tauri::AppHandle) -> Result<Endpoint> {
    let binary = binary()?;
    let (build, directory) = server_metadata(&binary)?;
    let plugins = if let Some(directory) = std::env::var_os("TOKAMAK_PLUGIN_DIR") {
        PathBuf::from(directory)
    } else if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins")
    } else {
        app.path().resource_dir()?.join("plugins")
    }
    .canonicalize()?;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(1))
        .build()?;
    if let Status::Reuse(endpoint) = status(&client, &directory, &plugins, &build)? {
        return Ok(endpoint);
    }
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let lock = directory.join("server-start.lock");
    let _owner = loop {
        match fs::create_dir(&lock) {
            Ok(()) => break LaunchLock(lock),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Status::Reuse(endpoint) = status(&client, &directory, &plugins, &build)? {
                    return Ok(endpoint);
                }
                if Instant::now() >= deadline {
                    return Err(
                        "Local server startup lock is busy or stale; inspect server-start.lock"
                            .into(),
                    );
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(error.into()),
        }
    };
    match status(&client, &directory, &plugins, &build)? {
        Status::Reuse(endpoint) => return Ok(endpoint),
        Status::Replace(identity) => stop(&client, &directory, &identity)?,
        Status::Offline => {}
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    ensure_token(&directory)?;
    let log = server_log(&directory)?;
    let mut command = server_command(&binary);
    command
        .args(["--local-dir"])
        .arg(&directory)
        .arg("--plugins")
        .arg(&plugins)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    loop {
        if let Status::Reuse(endpoint) = status(&client, &directory, &plugins, &build)? {
            return Ok(endpoint);
        }
        if let Some(exit) = child.try_wait()? {
            return Err(format!("Local server exited ({exit}); inspect server.log").into());
        }
        if Instant::now() >= deadline {
            return Err("Local server did not become ready; inspect server.log".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(build: Option<&str>) -> Identity {
        Identity {
            pid: 123,
            url: "ws://127.0.0.1:1234/ws".into(),
            bundle_hash: "a".repeat(64),
            build_id: build.map(str::to_owned),
            plugin_root: Some(PathBuf::from("plugins")),
        }
    }

    #[cfg(unix)]
    #[test]
    fn exited_server_child_is_reaped() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let process = LocalProcess::open(child.id()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !process.exited().unwrap() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        // waitpid in exited() has already reaped our child.
        let _ = child.wait();
    }

    #[test]
    fn matching_build_is_reused_and_old_or_missing_build_is_replaced() {
        for (build, reuse) in [(Some("current"), true), (Some("old"), false), (None, false)] {
            let discovered = identity(build);
            assert_eq!(
                reuse_decision(&discovered, &discovered, Path::new("plugins"), "current").unwrap(),
                reuse
            );
        }
    }

    #[test]
    fn identity_mismatch_never_authorizes_replacement() {
        let discovered = identity(None);
        let mut actual = identity(None);
        actual.pid += 1;
        assert!(reuse_decision(&discovered, &actual, Path::new("plugins"), "current").is_err());
        actual = identity(Some("different"));
        assert!(reuse_decision(&discovered, &actual, Path::new("plugins"), "current").is_err());
    }

    #[test]
    fn a_server_from_another_installation_is_replaced() {
        // Same build, but started from another plugins folder: never reused.
        let discovered = identity(Some("current"));
        assert!(!reuse_decision(&discovered, &discovered, Path::new("other"), "current").unwrap());
    }

    #[test]
    fn discovery_only_accepts_local_websocket_endpoints() {
        for url in ["ws://127.0.0.1:1234/ws", "ws://[::1]:1234/ws"] {
            let identity = Identity {
                pid: 1,
                url: url.into(),
                bundle_hash: "a".repeat(64),
                build_id: None,
                plugin_root: None,
            };
            assert!(discovery_url(&identity).is_ok());
        }
        for url in [
            "ws://example.com/ws",
            "ws://127.0.0.1/ws?token=x",
            "http://127.0.0.1/ws",
            "ws://user@127.0.0.1/ws",
            "ws://127.0.0.1/other",
        ] {
            let identity = Identity {
                pid: 1,
                url: url.into(),
                bundle_hash: "a".repeat(64),
                build_id: None,
                plugin_root: None,
            };
            assert!(discovery_url(&identity).is_err(), "{url}");
        }
    }
}
