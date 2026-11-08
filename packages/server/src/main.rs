//! Headless composition only: configuration and process signals live here, not
//! in storage/features. Local desktop mode uses an authenticated independent server.

use engine::{Bundle, PoolConfig};
use server::{Backend, BackendConfig, data::Storage, websocket};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

fn local_directory() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(std::env::var_os("TOKAMAK_SERVER_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            directories::ProjectDirs::from("com", "pixelscortex", "Tokamak")
                .map(|p| p.data_local_dir().to_owned())
        })
        .ok_or("Cannot locate application data directory")?)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut data = PathBuf::from("tokamak.db");
    let mut listen: SocketAddr = "127.0.0.1:3000".parse()?;
    let mut bundle = None;
    let mut local = None;
    let mut javascript = PoolConfig::default();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if flag == "--local-path" {
            println!("{}", local_directory()?.display());
            return Ok(());
        }
        if flag == "--help" {
            println!(
                "tokamak --bundle <feature.mjs> [--local-dir <private directory>] [--local-path] [--data <path>] [--listen <127.0.0.1:3000>] [--workers <n>] [--queue <n>] [--heap-bytes <n>] [--call-ms <n>] [--load-ms <n>]"
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
    let source = std::fs::read_to_string(bundle.ok_or("--bundle is required")?)?;
    let bundle_hash = format!("{:x}", Sha256::digest(source.as_bytes()));
    let token = if let Some(directory) = &local {
        data = directory.join("store");
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
        Some(token)
    } else {
        None
    };
    let bundle = Arc::new(Bundle::new(source, None)?);
    // Bind first: an unavailable address must not open storage or JS workers.
    let listener = tokio::net::TcpListener::bind(listen).await?;
    // Install fallible signal setup before owning any live datastore.
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let backend = Backend::start(BackendConfig {
        storage: Storage::Disk(data),
        bundle,
        javascript,
    })
    .await?;
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
