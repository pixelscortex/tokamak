use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
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

fn status(client: &Client, directory: &Path, plugins: &Path) -> Result<Option<Endpoint>> {
    let bytes = match fs::read(directory.join("server.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let identity: Identity = serde_json::from_slice(&bytes)?;
    let mut url = discovery_url(&identity)?;
    let capability = token(directory)?;
    url.set_scheme("http").map_err(|_| "Invalid scheme")?;
    url.set_path("/health");
    let response = match client.get(url.clone()).bearer_auth(&capability).send() {
        Ok(response) => response.error_for_status()?,
        Err(_) => return Ok(None),
    };
    let actual: Identity = serde_json::from_slice(&response.bytes()?)?;
    if actual != identity {
        return Err("Local server identity does not match discovery".into());
    }
    if identity.plugin_root.as_deref() != Some(plugins) {
        return Err("Local server uses a different plugin installation; stop it with server:stop before launching Tokamak".into());
    }
    url.set_path("");
    Ok(Some(Endpoint {
        http: url.to_string().trim_end_matches('/').to_owned(),
        ws: identity.url,
        token: Some(capability),
    }))
}

struct LaunchLock(PathBuf);
impl Drop for LaunchLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn ensure(app: &tauri::AppHandle) -> Result<Endpoint> {
    let binary = binary()?;
    let output = Command::new(&binary).arg("--local-path").output()?;
    if !output.status.success() {
        return Err("Cannot discover local server directory".into());
    }
    let directory = PathBuf::from(String::from_utf8(output.stdout)?.trim());
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
    if let Some(endpoint) = status(&client, &directory, &plugins)? {
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
                if let Some(endpoint) = status(&client, &directory, &plugins)? {
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
    if let Some(endpoint) = status(&client, &directory, &plugins)? {
        return Ok(endpoint);
    }
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
    token(&directory)?;
    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    let log = log_options.open(directory.join("server.log"))?;
    let mut command = Command::new(binary);
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
        if let Some(endpoint) = status(&client, &directory, &plugins)? {
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

    #[test]
    fn discovery_only_accepts_local_websocket_endpoints() {
        for url in ["ws://127.0.0.1:1234/ws", "ws://[::1]:1234/ws"] {
            let identity = Identity {
                pid: 1,
                url: url.into(),
                bundle_hash: "a".repeat(64),
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
                plugin_root: None,
            };
            assert!(discovery_url(&identity).is_err(), "{url}");
        }
    }
}
