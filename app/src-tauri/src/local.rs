use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use tempfile::{NamedTempFile, TempPath};
use tokamak_worker::{LocalRuntime, WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

#[derive(Default)]
pub struct Workers(Arc<Mutex<BTreeMap<String, Worker>>>);

struct Worker {
    writes: mpsc::Sender<Vec<u8>>,
    stop: CancellationToken,
    stopped: CancellationToken,
    provider_assets: Vec<TempPath>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Workers {
    /// Stops every local worker and waits until each has exited (quitting the app).
    pub async fn close_all(&self) {
        // A poisoned registry still holds the workers; quitting must close them all.
        let workers: Vec<Worker> = {
            let mut registry = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *registry).into_values().collect()
        };
        for worker in workers {
            worker.stop.cancel();
            worker.stopped.cancelled().await;
        }
    }
}

#[tauri::command]
pub async fn local_worker_start(
    app: tauri::AppHandle,
    workers: tauri::State<'_, Workers>,
    plugin: String,
    entry_hash: String,
    code_hash: String,
    events: Channel<Value>,
) -> Result<String, String> {
    let root = crate::server::plugin_root(&app).map_err(|error| error.to_string())?;
    let installed = root.clone();
    let plugin_id = plugin.clone();
    let (entry, code) =
        tokio::task::spawn_blocking(move || artifact(&installed, &plugin, &entry_hash, &code_hash))
            .await
            .map_err(|error| error.to_string())??;
    let paths = tokamak_worker::search_paths();
    let mut env = client_env(|name| std::env::var(name).ok());
    let data = tokio::task::spawn_blocking(crate::server::app_data_directory)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    env.insert(
        "TOKAMAK_APP_DATA_DIR".into(),
        data.to_string_lossy().into_owned(),
    );
    if let Ok(path) = std::env::join_paths(&paths) {
        env.insert("PATH".into(), path.to_string_lossy().into_owned());
    }
    // Start beside the install tree so a program without an explicit cwd
    // does not write into the plugin's installed build.
    let cwd = root.parent().unwrap_or(root.as_path());
    let (mut process, runtime) =
        tokamak_worker::Process::launch_local(&entry, &code, cwd, &env, &paths)?;
    let (input, output, stderr) = process.pipes()?;
    let id = uuid::Uuid::new_v4().to_string();
    // Limit queued frames and resident workers even if the window sends
    // faster than Bun can read from its pipe.
    let (writes, outgoing) = mpsc::channel(WORKER_CAPACITY);
    let stop = CancellationToken::new();
    let stopped = CancellationToken::new();
    let mut registry = workers.0.lock().map_err(|error| error.to_string())?;
    if registry.len() >= WORKER_CAPACITY {
        return Err("Local worker limit reached".into());
    }
    registry.insert(
        id.clone(),
        Worker {
            writes,
            stop: stop.clone(),
            stopped: stopped.clone(),
            provider_assets: Vec::new(),
        },
    );
    drop(registry);

    let registry = Arc::downgrade(&workers.0);
    let handle = id.clone();
    tokio::spawn(async move {
        let _assets = (entry, code);
        let _stopped = stopped.drop_guard();
        let _drain = AbortOnDropHandle::new(tokio::spawn(async move {
            let mut stderr = stderr;
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        }));
        let log_plugin = (runtime == LocalRuntime::QuickJs).then_some(plugin_id.as_str());
        let closed = tokio::select! {
            _ = stop.cancelled() => "Local worker stopped".into(),
            error = process.exited() => error,
            error = read(output, &events, log_plugin) => error,
            error = write(input, outgoing) => error,
        };
        process.stop().await;
        if let Some(registry) = registry.upgrade()
            && let Ok(mut workers) = registry.lock()
        {
            workers.remove(&handle);
        }
        let reason = if runtime == LocalRuntime::QuickJs {
            format!("Plugin host closed: {closed}")
        } else {
            closed
        };
        let _ = events.send(json!({ "type": "closed", "reason": reason }));
    });
    Ok(id)
}

#[tauri::command]
pub async fn local_worker_load(
    app: tauri::AppHandle,
    workers: tauri::State<'_, Workers>,
    id: String,
    plugin: String,
    entry_hash: String,
    code_hash: String,
) -> Result<String, String> {
    let root = crate::server::plugin_root(&app).map_err(|error| error.to_string())?;
    let code = tokio::task::spawn_blocking(move || {
        let folder = artifact_folder(&root, &plugin, &entry_hash, &code_hash)?;
        snapshot(&folder, "local.js", &code_hash)
    })
    .await
    .map_err(|error| error.to_string())??;
    let path = code
        .to_str()
        .ok_or("Local provider path is not UTF-8")?
        .to_owned();
    let mut registry = workers.0.lock().map_err(|error| error.to_string())?;
    let worker = registry.get_mut(&id).ok_or("Local worker closed")?;
    // Bun opens the exact verified copy and caches its modules by file URL.
    worker.provider_assets.push(code);
    Ok(path)
}

#[tauri::command]
pub fn local_worker_write(
    workers: tauri::State<'_, Workers>,
    id: String,
    message: Value,
) -> Result<(), String> {
    let mut line = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    // Match the worker's frame bound before anything enters its queue.
    if line.len() >= WORKER_FRAME_BYTES {
        return Err("Local worker message exceeds 1 MiB".into());
    }
    line.push(b'\n');
    workers
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .ok_or("Local worker closed")?
        .writes
        .try_send(line)
        .map_err(|_| "Local worker input queue full or closed".into())
}

#[tauri::command]
pub async fn local_worker_close(
    workers: tauri::State<'_, Workers>,
    id: String,
) -> Result<(), String> {
    let worker = workers
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    if let Some(worker) = worker {
        worker.stop.cancel();
        worker.stopped.cancelled().await;
    }
    Ok(())
}

async fn read(
    output: impl tokio::io::AsyncRead + Unpin,
    events: &Channel<Value>,
    log_plugin: Option<&str>,
) -> String {
    let mut output = BufReader::new(output);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut output)
            .take((WORKER_FRAME_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .await;
        match read {
            Ok(0) => return "Local worker output closed".into(),
            Ok(n) if n <= WORKER_FRAME_BYTES && line.last() == Some(&b'\n') => {}
            Ok(_) => return "Invalid local worker frame".into(),
            Err(error) => return error.to_string(),
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
            return "Invalid local worker JSON".into();
        };
        // Logs are not part of the request channel.
        if message["type"] == "log" {
            if let Some(plugin) = log_plugin {
                let level = message["level"].as_str().unwrap_or("info");
                let text = message["text"].as_str().unwrap_or("");
                tokamak_worker::log(format!("Plugin {plugin} [{level}]: {text}"));
            }
            continue;
        }
        if events
            .send(json!({ "type": "message", "message": message }))
            .is_err()
        {
            return "Local worker window closed".into();
        }
    }
}

async fn write(
    mut input: impl AsyncWriteExt + Unpin,
    mut outgoing: mpsc::Receiver<Vec<u8>>,
) -> String {
    while let Some(line) = outgoing.recv().await {
        let sent = tokio::time::timeout(Duration::from_secs(5), async {
            input.write_all(&line).await?;
            input.flush().await
        })
        .await;
        match sent {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return error.to_string(),
            Err(_) => return "Local worker input stalled".into(),
        }
    }
    "Local worker input closed".into()
}

fn artifact(
    root: &Path,
    plugin: &str,
    entry_hash: &str,
    code_hash: &str,
) -> Result<(TempPath, TempPath), String> {
    let folder = artifact_folder(root, plugin, entry_hash, code_hash)?;
    Ok((
        snapshot(&folder, "local-entry.js", entry_hash)?,
        snapshot(&folder, "local.js", code_hash)?,
    ))
}

fn artifact_folder(
    root: &Path,
    plugin: &str,
    entry_hash: &str,
    code_hash: &str,
) -> Result<std::path::PathBuf, String> {
    if plugin.is_empty()
        || matches!(plugin, "." | "..")
        || plugin.len() > 128
        || !plugin
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    {
        return Err("Invalid local plugin identity".into());
    }
    let matches = |path: &Path| {
        let manifest = File::open(path.join("manifest.json")).ok()?;
        let json: Value = serde_json::from_reader(manifest.take(WORKER_FRAME_BYTES as u64)).ok()?;
        (json["plugin"]["id"] == plugin
            && json["entries"]["local"]["entry"] == "local-entry.js"
            && json["entries"]["local"]["code"] == "local.js"
            && json["hashes"]["local-entry.js"] == entry_hash
            && json["hashes"]["local.js"] == code_hash)
            .then(|| path.to_owned())
    };
    // Prefer the usual id-named path, but dev installs may use other folder names.
    let folder = [root.to_owned(), root.join(plugin)]
        .into_iter()
        .flat_map(|dir| [dir.join("dist"), dir])
        .find_map(|dir| matches(&dir))
        .or_else(|| {
            std::fs::read_dir(root)
                .ok()?
                .filter_map(Result::ok)
                .find_map(|item| {
                    let dir = item.path();
                    matches(&dir).or_else(|| matches(&dir.join("dist")))
                })
        })
        .ok_or_else(|| {
            format!(
                "Install the matching build of {plugin} on this client to run its local functions"
            )
        })?;
    let folder = folder.canonicalize().map_err(|error| error.to_string())?;
    if !folder.starts_with(root) {
        return Err("Local plugin path escapes its install directory".into());
    }
    Ok(folder)
}

fn snapshot(folder: &Path, file: &str, hash: &str) -> Result<TempPath, String> {
    let path = folder
        .join(file)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(folder) {
        return Err("Local plugin asset escapes its install directory".into());
    }
    let mut source = File::open(path).map_err(|error| error.to_string())?;
    if !source
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Local plugin asset must be a regular file".into());
    }
    // Run the verified bytes, even if the installed build is replaced between
    // this check and Bun opening the file.
    let mut copy: NamedTempFile = tempfile::Builder::new()
        .suffix(".mjs")
        .tempfile()
        .map_err(|error| error.to_string())?;
    let mut actual = Sha256::new();
    let mut bytes = [0; 16 * 1024];
    loop {
        let size = source.read(&mut bytes).map_err(|error| error.to_string())?;
        if size == 0 {
            break;
        }
        actual.update(&bytes[..size]);
        copy.write_all(&bytes[..size])
            .map_err(|error| error.to_string())?;
    }
    if format!("{:x}", actual.finalize()) != hash {
        return Err(format!("Local plugin asset hash mismatch: {file}"));
    }
    Ok(copy.into_temp_path())
}

fn client_env(mut read: impl FnMut(&str) -> Option<String>) -> BTreeMap<String, String> {
    // Programs need OS paths and selected client configuration. Do not pass
    // provider keys or arbitrary overrides inherited by the client.
    [
        "HOME",
        // Both CLI profiles can live outside HOME.
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "USER",
        "LANG",
        "SHELL",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "COMSPEC",
        "PATHEXT",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_DATA_HOME",
        "TEMP",
        "TMP",
        "USERNAME",
        "HOMEDRIVE",
        "HOMEPATH",
    ]
    .into_iter()
    .filter_map(|name| read(name).map(|value| (name.to_owned(), value)))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    const ENTRY_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const CODE_HASH: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn install(root: &Path) -> PathBuf {
        let folder = root.join("example").join("dist");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("manifest.json"),
            json!({
                "plugin": { "id": "example" },
                "entries": { "local": { "entry": "local-entry.js", "code": "local.js" } },
                "hashes": { "local-entry.js": ENTRY_HASH, "local.js": CODE_HASH },
            })
            .to_string(),
        )
        .unwrap();
        fs::write(folder.join("local-entry.js"), "").unwrap();
        fs::write(folder.join("local.js"), "abc").unwrap();
        folder
    }

    #[test]
    fn snapshots_an_installed_artifact_before_it_is_replaced() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let folder = install(&root);
        let (_, code) = artifact(&root, "example", ENTRY_HASH, CODE_HASH).unwrap();
        fs::write(folder.join("local.js"), "replacement").unwrap();
        assert_eq!(fs::read_to_string(&code).unwrap(), "abc");
    }

    #[test]
    fn rejects_artifact_bytes_that_do_not_match_the_manifest() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let folder = install(&root);
        fs::write(folder.join("local.js"), "tampered").unwrap();
        assert_eq!(
            artifact(&root, "example", ENTRY_HASH, CODE_HASH).unwrap_err(),
            "Local plugin asset hash mismatch: local.js"
        );
    }

    #[test]
    fn requires_a_matching_local_install() {
        let root = tempfile::tempdir().unwrap();
        let error = artifact(root.path(), "example", ENTRY_HASH, CODE_HASH).unwrap_err();
        assert!(error.contains("Install the matching build of example"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_installed_folder_outside_the_plugin_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        install(outside.path());
        std::os::unix::fs::symlink(outside.path().join("example"), root.path().join("example"))
            .unwrap();
        assert_eq!(
            artifact(root.path(), "example", ENTRY_HASH, CODE_HASH).unwrap_err(),
            "Local plugin path escapes its install directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_asset_outside_its_installed_folder() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let folder = install(&root);
        let outside = root.join("outside.js");
        fs::write(&outside, "abc").unwrap();
        fs::remove_file(folder.join("local.js")).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("local.js")).unwrap();
        assert_eq!(
            artifact(&root, "example", ENTRY_HASH, CODE_HASH).unwrap_err(),
            "Local plugin asset escapes its install directory"
        );
    }

    #[test]
    fn client_environment_keeps_os_paths_and_drops_application_secrets() {
        let inherited = BTreeMap::from([
            ("HOME", "/home/user"),
            ("CLAUDE_CONFIG_DIR", "/home/user/custom-claude"),
            ("CODEX_HOME", "/home/user/custom-codex"),
            ("SSH_AUTH_SOCK", "/tmp/example-ssh-agent.sock"),
            ("SSH_AGENT_PID", "1000"),
            ("HTTPS_PROXY", "https://proxy.example"),
            ("HTTP_PROXY", "http://proxy.example"),
            ("NO_PROXY", "localhost"),
            ("NODE_EXTRA_CA_CERTS", "/home/user/ca.pem"),
            ("SYSTEMROOT", "C:/Windows"),
            ("XDG_DATA_HOME", "/home/user/.data"),
            ("TOKAMAK_PLUGIN_DIR", "/private/plugins"),
            ("ANTHROPIC_API_KEY", "credential"),
            ("ANTHROPIC_AUTH_TOKEN", "credential"),
            ("ANTHROPIC_BASE_URL", "https://gateway.example"),
            ("NODE_OPTIONS", "--require /tmp/injected.js"),
            ("PATH", "/untrusted/path"),
        ]);
        let env = client_env(|name| inherited.get(name).map(ToString::to_string));
        assert_eq!(
            env,
            BTreeMap::from([
                ("HOME".into(), "/home/user".into()),
                (
                    "CLAUDE_CONFIG_DIR".into(),
                    "/home/user/custom-claude".into()
                ),
                ("CODEX_HOME".into(), "/home/user/custom-codex".into()),
                ("SSH_AUTH_SOCK".into(), "/tmp/example-ssh-agent.sock".into()),
                ("SSH_AGENT_PID".into(), "1000".into()),
                ("HTTPS_PROXY".into(), "https://proxy.example".into()),
                ("HTTP_PROXY".into(), "http://proxy.example".into()),
                ("NO_PROXY".into(), "localhost".into()),
                ("NODE_EXTRA_CA_CERTS".into(), "/home/user/ca.pem".into()),
                ("SYSTEMROOT".into(), "C:/Windows".into()),
                ("XDG_DATA_HOME".into(), "/home/user/.data".into()),
            ]),
        );
    }
}
