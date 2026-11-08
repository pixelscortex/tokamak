//! Headless composition only: configuration and process signals live here, not
//! in storage/features. Local desktop mode uses an authenticated independent server.

use engine::{Bundle, PoolConfig};
use server::{Backend, BackendConfig, data::Storage, websocket};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

fn local_ownership(directory: &Path) -> Result<File, Box<dyn std::error::Error>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(directory.join("server-owner.lock"))?;
    file.try_lock()
        .map_err(|error| format!("Cannot acquire local server ownership: {error}"))?;
    Ok(file)
}

fn local_directory() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(std::env::var_os("TOKAMAK_SERVER_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            directories::ProjectDirs::from("com", "pixelscortex", "Tokamak")
                .map(|p| p.data_local_dir().to_owned())
        })
        .ok_or("Cannot locate application data directory")?)
}

fn capability(directory: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let path = directory.join("server.token");
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() {
        return Err("local capability must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("local capability must be private (chmod 600)".into());
        }
    }
    let token = std::fs::read_to_string(path)?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid local capability".into());
    }
    Ok(token)
}

async fn plugin_command(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let path = match args.as_slice() {
        [command] if command == "list" => "/plugins".to_owned(),
        [command, id] if command == "reload" => {
            server::data::DataSpace::plugin(id)?;
            format!("/plugins/{id}/reload")
        }
        _ => return Err("Expected: tokamak plugin list | tokamak plugin reload <id>".into()),
    };
    let directory = local_directory()?;
    let identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("server.json"))?)?;
    let mut url = reqwest::Url::parse(identity["url"].as_str().ok_or("Invalid local discovery")?)?;
    if url.scheme() != "ws"
        || url.path() != "/ws"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url
            .host_str()
            .ok_or("Missing server host")?
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()?
            .is_loopback()
    {
        return Err("Only discovered loopback ws:// endpoints are supported".into());
    }
    url.set_scheme("http")
        .map_err(|_| "Invalid local URL scheme")?;
    url.set_path(&path);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?;
    let request = if args[0] == "list" {
        client.get(url)
    } else {
        client.post(url)
    };
    let response = request.bearer_auth(capability(&directory)?).send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(format!("Plugin command refused ({status}): {body}").into());
    }
    println!("{body}");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut data = PathBuf::from("tokamak.db");
    let mut listen: SocketAddr = "127.0.0.1:3000".parse()?;
    let mut bundle = None;
    let mut plugins = None;
    let mut local = None;
    let mut javascript = PoolConfig::default();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if flag == "plugin" {
            return plugin_command(args.collect()).await;
        }
        if flag == "--local-path" {
            println!("{}", local_directory()?.display());
            return Ok(());
        }
        if flag == "--help" {
            println!(
                "tokamak (--plugins <directory> | --bundle <legacy feature.mjs>) [--local-dir <private directory>] [--local-path] [--data <path>] [--listen <127.0.0.1:3000>] [--workers <n>] [--queue <n>] [--heap-bytes <n>] [--call-ms <n>] [--load-ms <n>]\nControl: tokamak plugin list | tokamak plugin reload <id> (TOKAMAK_SERVER_DIR selects local server)"
            );
            return Ok(());
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--data" => data = value.into(),
            "--listen" => listen = value.parse()?,
            "--bundle" => bundle = Some(PathBuf::from(value)),
            "--plugins" => plugins = Some(PathBuf::from(value)),
            "--local-dir" => {
                local = Some(PathBuf::from(value));
                listen = "127.0.0.1:0".parse()?;
            }
            "--workers" => javascript.workers = value.parse()?,
            "--queue" => javascript.queue_capacity = value.parse()?,
            "--heap-bytes" => javascript.limits.heap_bytes = value.parse()?,
            "--call-ms" => javascript.limits.call_timeout = Duration::from_millis(value.parse()?),
            "--load-ms" => javascript.limits.load_timeout = Duration::from_millis(value.parse()?),
            _ => return Err(format!("unknown option {flag}").into()),
        }
    }
    if !listen.ip().is_loopback() {
        return Err("unauthenticated POC must bind loopback".into());
    }
    if bundle.is_some() == plugins.is_some() {
        return Err("Specify exactly one of --plugins or --bundle".into());
    }
    let source = bundle.map(std::fs::read_to_string).transpose()?;
    let token = if let Some(directory) = &local {
        data = directory.join("store");
        Some(capability(directory)?)
    } else {
        None
    };
    // Keep ownership until AFTER ready-file removal. The database lock alone
    // releases during close(): a replacement could otherwise publish readiness
    // in that gap and have this process remove the replacement's descriptor.
    let _local_owner = local.as_deref().map(local_ownership).transpose()?;
    // Bind first: an unavailable address must not open storage or JS workers.
    let listener = tokio::net::TcpListener::bind(listen).await?;
    // Install fallible signal setup before owning any live datastore.
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let (backend, bundle_hash) = if let Some(root) = plugins {
        let backend = Backend::start_plugins(Storage::Disk(data), javascript, &root).await?;
        let hash = backend.server().plugins().await?["revision"]
            .as_str()
            .ok_or("Missing catalog revision")?
            .to_owned();
        (backend, hash)
    } else {
        let source = source.expect("validated legacy source");
        let hash = format!("{:x}", Sha256::digest(source.as_bytes()));
        let backend = Backend::start(BackendConfig {
            storage: Storage::Disk(data),
            bundle: Arc::new(Bundle::new(source, None)?),
            javascript,
        })
        .await?;
        (backend, hash)
    };
    let identity = serde_json::json!({
        "url": format!("ws://{}/ws", listener.local_addr()?),
        "pid": std::process::id(),
        "bundleHash": bundle_hash,
    });
    if let Some(directory) = &local {
        let temporary = directory.join(format!("server.json.{}.tmp", std::process::id()));
        let published = std::fs::write(&temporary, identity.to_string())
            .and_then(|_| std::fs::rename(&temporary, directory.join("server.json")));
        if let Err(error) = published {
            let _ = std::fs::remove_file(temporary);
            backend.close().await?;
            return Err(error.into());
        }
    }
    println!(
        "Tokamak listening on ws://{}/ws ({}, no TLS)",
        listener.local_addr()?,
        if token.is_some() {
            "local capability"
        } else {
            "unauthenticated local POC"
        }
    );
    let serving = websocket::serve_with_access(
        listener,
        backend.server().clone(),
        async move {
            // SIGTERM is used by process managers; Ctrl-C is the interactive path.
            #[cfg(unix)]
            {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
        },
        token.map(|token| websocket::LocalAccess { token, identity }),
    )
    .await;
    let closed = backend.close().await;
    if closed.is_ok() {
        if let Some(directory) = local {
            // Readiness disappears only after the datastore shutdown barrier.
            let _ = std::fs::remove_file(directory.join("server.json"));
        }
    }
    // Always await storage cleanup even when serving failed; retain both errors.
    match (serving, closed) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error.into()),
        (Ok(()), Err(error)) => Err(error.into()),
        (Err(error), Err(close)) => Err(format!("{error}; shutdown failed: {close}").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_owner_covers_database_close_and_discovery_cleanup() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("dist/tests/local-owner-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        let owner = local_ownership(&path).unwrap();
        // Model the phase after the datastore lock has been released but the
        // old process has not yet removed its discovery file.
        assert!(local_ownership(&path).is_err());
        drop(owner);
        let replacement = local_ownership(&path).unwrap();
        drop(replacement);
        std::fs::remove_dir_all(path).unwrap();
    }
}
