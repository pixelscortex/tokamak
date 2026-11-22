//! Headless composition only: configuration and process signals live here, not
//! in storage/features. Local desktop mode uses an authenticated independent server.

mod scaffold;

use engine::{Bundle, PoolConfig};
use server::{Backend, BackendConfig, data::Storage, websocket};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

// Hash the executable rather than the plugin catalog: native host changes must
// invalidate reuse even when the JavaScript and package version are unchanged.
fn build_id() -> Result<String, Box<dyn std::error::Error>> {
    let mut executable = File::open(std::env::current_exe()?)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = executable.read(&mut buffer)?;
        if count == 0 {
            return Ok(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..count]);
    }
}

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
        [command, path] if command == "create" => return scaffold::create(Path::new(path)),
        [command] if command == "list" => "/plugins".to_owned(),
        [command, id] if command == "reload" => {
            server::data::DataSpace::plugin(id)?;
            format!("/plugins/{id}/reload")
        }
        _ => {
            return Err(
                "Expected: tokamak-server plugin create <folder> | tokamak-server plugin list | tokamak-server plugin reload <id>".into(),
            );
        }
    };
    let body = if args[0] == "list" {
        None
    } else {
        Some(serde_json::json!({}))
    };
    println!("{}", local_request(&path, body).await?);
    Ok(())
}

async fn local_request(
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
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
    url.set_path(path);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?;
    let request = if let Some(body) = body {
        client
            .post(url)
            .header("content-type", "application/json")
            .body(body.to_string())
    } else {
        client.get(url)
    };
    let response = request.bearer_auth(capability(&directory)?).send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(format!("Local command refused ({status}): {body}").into());
    }
    Ok(serde_json::from_str(&body)?)
}

struct Configuration {
    data: PathBuf,
    listen: SocketAddr,
    bundle: Option<PathBuf>,
    plugins: Option<PathBuf>,
    local: Option<PathBuf>,
    javascript: PoolConfig,
    web: Option<PathBuf>,
}

async fn configuration() -> Result<Option<Configuration>, Box<dyn std::error::Error>> {
    let mut data = PathBuf::from("tokamak.db");
    let mut listen = None;
    let mut web = std::env::var_os("TOKAMAK_WEB_DIR").map(PathBuf::from);
    let mut bundle = None;
    let mut plugins = None;
    let mut local = None;
    let mut javascript = PoolConfig::default();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if matches!(flag.as_str(), "members" | "revoke") {
            server::identity::command(&flag, args.collect()).await?;
            return Ok(None);
        }
        if flag == "plugin" {
            plugin_command(args.collect()).await?;
            return Ok(None);
        }
        if flag == "--build-id" {
            println!("{}", build_id()?);
            return Ok(None);
        }
        if flag == "--local-path" {
            println!("{}", local_directory()?.display());
            return Ok(None);
        }
        if flag == "--help" {
            println!(
                "tokamak-server (--plugins <directory> | --bundle <legacy feature.mjs>) [--local-dir <private directory>] [--local-path] [--build-id] [--data <path>] [--listen <127.0.0.1:3000>] [--web <directory>] [--workers <n>] [--queue <n>] [--heap-bytes <n>] [--call-ms <n>] [--load-ms <n>]\nMembers: tokamak-server members | revoke <id> --server <https://address> [--token <owner key>] (or TOKAMAK_TOKEN)\nControl: tokamak-server plugin create <folder> | tokamak-server plugin list | tokamak-server plugin reload <id> (TOKAMAK_SERVER_DIR selects local server)"
            );
            return Ok(None);
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--data" => data = value.into(),
            "--listen" => listen = Some(value.parse::<SocketAddr>()?),
            "--web" => web = Some(PathBuf::from(value)),
            "--bundle" => bundle = Some(PathBuf::from(value)),
            "--plugins" => plugins = Some(PathBuf::from(value)),
            "--local-dir" => {
                local = Some(PathBuf::from(value));
                // A local server picks a free loopback port unless a later --listen names one.
                listen = Some("127.0.0.1:0".parse()?);
            }
            "--workers" => javascript.workers = value.parse()?,
            "--queue" => javascript.queue_capacity = value.parse()?,
            "--heap-bytes" => javascript.limits.heap_bytes = value.parse()?,
            "--call-ms" => javascript.limits.call_timeout = Duration::from_millis(value.parse()?),
            "--load-ms" => javascript.limits.load_timeout = Duration::from_millis(value.parse()?),
            _ => return Err(format!("unknown option {flag}").into()),
        }
    }
    if local.is_some() && web.is_some() {
        return Err("--web cannot be combined with --local-dir".into());
    }
    let listen = if let Some(listen) = listen {
        listen
    } else if let Ok(port) = std::env::var("PORT") {
        SocketAddr::from(([0, 0, 0, 0], port.parse::<u16>()?))
    } else {
        "127.0.0.1:3000".parse()?
    };
    Ok(Some(Configuration {
        data,
        listen,
        bundle,
        plugins,
        local,
        javascript,
        web,
    }))
}

async fn start_backend(
    data: PathBuf,
    javascript: PoolConfig,
    plugins: Option<PathBuf>,
    source: Option<String>,
    hosted: bool,
) -> Result<(Backend, String), Box<dyn std::error::Error>> {
    let result = if let Some(root) = plugins {
        let backend = if hosted {
            Backend::start_shared_plugins(Storage::Disk(data), javascript, &root).await?
        } else {
            Backend::start_plugins(Storage::Disk(data), javascript, &root).await?
        };
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
    Ok(result)
}

async fn publish_identity(
    directory: Option<&Path>,
    identity: &serde_json::Value,
    backend: &Backend,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(directory) = directory {
        let temporary = directory.join(format!("server.json.{}.tmp", std::process::id()));
        let published = std::fs::write(&temporary, identity.to_string())
            .and_then(|_| std::fs::rename(&temporary, directory.join("server.json")));
        if let Err(error) = published {
            let _ = std::fs::remove_file(temporary);
            backend.close().await?;
            return Err(error.into());
        }
    }
    Ok(())
}

fn hosted_token(hosted: bool) -> Result<Option<String>, Box<dyn std::error::Error>> {
    if !hosted {
        return Ok(None);
    }
    let token = std::env::var("TOKAMAK_ACCESS_TOKEN")
        .map_err(|_| "Hosted mode requires TOKAMAK_ACCESS_TOKEN (at least 32 characters)")?;
    if token.chars().count() < 32 {
        return Err("TOKAMAK_ACCESS_TOKEN must contain at least 32 characters".into());
    }
    Ok(Some(token))
}

fn log_listening(address: SocketAddr, authenticated: bool, hosted: bool) {
    println!(
        "Tokamak listening on ws://{}/ws ({}, no TLS)",
        address,
        if authenticated {
            if hosted {
                "hosted access token"
            } else {
                "local capability"
            }
        } else {
            "unauthenticated local POC"
        }
    );
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(Configuration {
        mut data,
        listen,
        bundle,
        plugins,
        local,
        javascript,
        web,
    }) = configuration().await?
    else {
        return Ok(());
    };
    let hosted = web.is_some();
    let hosted_token = hosted_token(hosted)?;
    if !listen.ip().is_loopback() && !hosted {
        return Err("Non-loopback listeners require --web and TOKAMAK_ACCESS_TOKEN".into());
    }
    let web = websocket::HostedWeb::configure(web, listen)?;
    if bundle.is_some() == plugins.is_some() {
        return Err("Specify exactly one of --plugins or --bundle".into());
    }
    let source = bundle.map(std::fs::read_to_string).transpose()?;
    let token = if let Some(directory) = &local {
        data = directory.join("store");
        Some(capability(directory)?)
    } else {
        hosted_token
    };
    let identities = Arc::new(server::identity::Identities::configure(
        &data,
        token.as_deref(),
        hosted,
    )?);
    // Keep ownership until AFTER ready-file removal. The database lock alone
    // releases during close(): a replacement could otherwise publish readiness
    // in that gap and have this process remove the replacement's descriptor.
    let _local_owner = local.as_deref().map(local_ownership).transpose()?;
    // Bind first: an unavailable address must not open storage or JS workers.
    let listener = tokio::net::TcpListener::bind(listen).await?;
    // Install fallible signal setup before owning any live datastore.
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let plugin_root = plugins.as_ref().map(std::fs::canonicalize).transpose()?;
    let build_id = build_id()?;
    let (backend, bundle_hash) = start_backend(data, javascript, plugins, source, hosted).await?;
    let identity = serde_json::json!({
        "url": format!("ws://{}/ws", listener.local_addr()?),
        "pid": std::process::id(),
        "bundleHash": bundle_hash,
        "buildId": build_id,
        "pluginRoot": plugin_root,
    });
    publish_identity(local.as_deref(), &identity, &backend).await?;
    log_listening(listener.local_addr()?, token.is_some(), hosted);
    let serving = websocket::serve_with_identities(
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
        web,
        identities,
    )
    .await;
    let closed = backend.close().await;
    if closed.is_ok()
        && let Some(directory) = local
    {
        // Readiness disappears only after the datastore shutdown barrier.
        let _ = std::fs::remove_file(directory.join("server.json"));
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
