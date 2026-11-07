//! Headless composition only: configuration and process signals live here, not
//! in storage/features. The desktop embeds Backend without this network adapter.

use runtime::{Bundle, PoolConfig};
use server::{Backend, BackendConfig, data::Storage, websocket};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut data = PathBuf::from("tokamak.db");
    let mut listen: SocketAddr = "127.0.0.1:3000".parse()?;
    let mut bundle = None;
    let mut javascript = PoolConfig::default();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if flag == "--help" {
            println!(
                "tokamak --bundle <feature.mjs> [--data <path>] [--listen <127.0.0.1:3000>] [--workers <n>] [--queue <n>] [--heap-bytes <n>] [--call-ms <n>] [--load-ms <n>]"
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
    println!(
        "Tokamak listening on ws://{}/ws (local POC, no auth/TLS)",
        listener.local_addr()?
    );
    let serving = websocket::serve(listener, backend.server().clone(), async move {
        // SIGTERM is used by process managers; Ctrl-C is the interactive path.
        #[cfg(unix)]
        {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    })
    .await;
    let closed = backend.close().await;
    // Always await storage cleanup even when serving failed; retain both errors.
    match (serving, closed) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error.into()),
        (Ok(()), Err(error)) => Err(error.into()),
        (Err(error), Err(close)) => Err(format!("{error}; shutdown failed: {close}").into()),
    }
}
