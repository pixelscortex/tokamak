#![cfg(any(target_os = "macos", target_os = "linux"))]

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    path::Path,
};
use tempfile::{NamedTempFile, TempPath};
use tokamak_worker::WORKER_FRAME_BYTES;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn quickjs_bundle(
    root: &Path,
    request: &crate::local::Artifact,
) -> Result<TempPath, String> {
    let (folder, manifest) =
        artifact_folder(root, &request.id, &request.entry_hash, &request.code_hash)?;
    for contract in ["contracts", "contractProviders"]
        .into_iter()
        .flat_map(|field| manifest[field].as_array().into_iter().flatten())
    {
        if contract["place"] == "local" && contract["dataMethods"] != true {
            let name = contract["name"].as_str().unwrap_or("<unnamed>");
            let owner = contract["owner"].as_str().unwrap_or(&request.id);
            return Err(format!(
                "Local contract {owner}/{name} is not all plain data; QuickJS requires dataMethods: true. Rebuild or update this plugin."
            ));
        }
    }
    // Verify both assets as part of the build identity, even though QuickJS
    // only evaluates the local bundle.
    let _entry = snapshot(&folder, "local-entry.js", &request.entry_hash)?;
    snapshot(&folder, "local.js", &request.code_hash)
}

pub(super) fn artifact_folder(
    root: &Path,
    plugin: &str,
    entry_hash: &str,
    code_hash: &str,
) -> Result<(std::path::PathBuf, Value), String> {
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
            .then(|| (path.to_owned(), json))
    };
    // Prefer the usual id-named path, but dev installs may use other folder names.
    let (folder, manifest) = [root.to_owned(), root.join(plugin)]
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
                "Install the matching build of {plugin} on this machine to run its local functions"
            )
        })?;
    let folder = folder.canonicalize().map_err(|error| error.to_string())?;
    if !folder.starts_with(root) {
        return Err("Local plugin path escapes its install directory".into());
    }
    Ok((folder, manifest))
}

pub(super) fn snapshot(folder: &Path, file: &str, hash: &str) -> Result<TempPath, String> {
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
    // this check and the plugin process opening the file.
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

pub(super) fn client_env(mut read: impl FnMut(&str) -> Option<String>) -> BTreeMap<String, String> {
    // Programs need OS paths and selected client configuration. Do not pass
    // provider keys or arbitrary overrides inherited by the Runner.
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

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    fn bundle(root: &Path) -> Result<TempPath, String> {
        quickjs_bundle(
            root,
            &crate::local::Artifact {
                id: "example".into(),
                entry_hash: ENTRY_HASH.into(),
                code_hash: CODE_HASH.into(),
            },
        )
    }

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
        let code = bundle(&root).unwrap();
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
            bundle(&root).unwrap_err(),
            "Local plugin asset hash mismatch: local.js"
        );
    }

    #[test]
    fn requires_a_matching_local_install() {
        let root = tempfile::tempdir().unwrap();
        let error = bundle(root.path()).unwrap_err();
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
            bundle(root.path()).unwrap_err(),
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
            bundle(&root).unwrap_err(),
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
