mod artifact;
mod local;
mod ownership;

use engine::PoolConfig;
use server::{Backend, data::Storage, websocket};
use std::{
    ffi::OsString,
    io::Read,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

struct Config {
    data: PathBuf,
    plugins: PathBuf,
    listen: SocketAddr,
    desktop: bool,
    token_file: Option<PathBuf>,
}

impl Config {
    fn read() -> anyhow::Result<Option<Self>> {
        let mut args = std::env::args_os().skip(1);
        let mut data = None;
        let mut plugins = None;
        let mut listen = None;
        let mut token_file = None;
        let mut desktop = false;
        while let Some(flag) = args.next() {
            let value = |args: &mut dyn Iterator<Item = OsString>| {
                args.next()
                    .ok_or_else(|| anyhow::anyhow!("Missing value for {}", flag.to_string_lossy()))
            };
            match flag.to_str() {
                Some("--help") => {
                    println!(
                        "tokamak-runner --plugins <directory> --data <path> --token-file <private file> [--listen <127.0.0.1:3000>]"
                    );
                    return Ok(None);
                }
                Some("--plugin-runtime") => {
                    println!(
                        "{}",
                        tokamak_worker::LocalRuntime::selected()
                            .map_err(anyhow::Error::msg)?
                            .name()
                    );
                    return Ok(None);
                }
                Some("--desktop") => desktop = true,
                Some("--plugins") => plugins = Some(PathBuf::from(value(&mut args)?)),
                Some("--data") => data = Some(PathBuf::from(value(&mut args)?)),
                Some("--listen") => {
                    listen = Some(value(&mut args)?.to_string_lossy().parse::<SocketAddr>()?)
                }
                Some("--token-file") => token_file = Some(PathBuf::from(value(&mut args)?)),
                _ => anyhow::bail!("Unknown option {}", flag.to_string_lossy()),
            }
        }
        anyhow::ensure!(
            desktop == token_file.is_none(),
            "Standalone Runner requires --token-file; desktop uses its private pipe"
        );
        anyhow::ensure!(
            !desktop || listen.is_none(),
            "The desktop Runner picks its own loopback port"
        );
        let listen = listen.unwrap_or_else(|| {
            SocketAddr::from((
                Ipv4Addr::LOCALHOST,
                if desktop {
                    0
                } else {
                    3000
                },
            ))
        });
        anyhow::ensure!(listen.ip().is_loopback(), "Runner must bind to loopback");
        Ok(Some(Self {
            data: data.ok_or_else(|| anyhow::anyhow!("Missing --data"))?,
            plugins: plugins.ok_or_else(|| anyhow::anyhow!("Missing --plugins"))?,
            desktop,
            token_file,
            listen,
        }))
    }
}

fn access(config: &Config, stop: CancellationToken) -> anyhow::Result<String> {
    let token = if config.desktop {
        // No workspace or plugin code starts until the supervisor has set up
        // the guardian/job and written the secret.
        let mut frame = [0; 65];
        std::io::stdin().read_exact(&mut frame)?;
        anyhow::ensure!(frame[64] == b'\n', "Invalid desktop handshake");
        let watcher = std::thread::Builder::new().name("desktop-liveness".into());
        watcher.spawn(move || {
            // The desktop sends no further bytes. EOF requests graceful
            // shutdown; the guardian covers a stalled or crashed process.
            let _ = std::io::stdin().read(&mut [0]);
            stop.cancel();
        })?;
        String::from_utf8(frame[..64].to_vec())?
    } else {
        let path = config
            .token_file
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Missing token file"))?;
        let metadata = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(metadata.is_file(), "Token must be a regular file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            anyhow::ensure!(
                metadata.permissions().mode() & 0o077 == 0,
                "Token file must be private (chmod 600)"
            );
        }
        let mut token = String::new();
        std::fs::File::open(path)?
            .take(67)
            .read_to_string(&mut token)?;
        token.trim_end_matches(['\r', '\n']).to_owned()
    };
    anyhow::ensure!(
        token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Expected a 64-digit hex secret"
    );
    Ok(token)
}

async fn signals(stop: CancellationToken) -> std::io::Result<()> {
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::spawn(async move {
        #[cfg(unix)]
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        stop.cancel();
    });
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let Some(config) = Config::read()? else {
        return Ok(());
    };
    let stop = CancellationToken::new();
    let token = access(&config, stop.clone())?;
    signals(stop.clone()).await?;
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    let address = listener.local_addr()?;
    let plugins = config.plugins.canonicalize()?;
    let app_data = config
        .data
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .canonicalize()?;
    let data = app_data.join(
        config
            .data
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("Expected a store folder"))?,
    );
    if config.desktop {
        ownership::private_directory(&app_data)?;
    }
    ownership::private_directory(&data)?;
    let data = data.canonicalize()?;
    let directory = if config.desktop {
        &app_data
    } else {
        &data
    };
    let legacy = (config.desktop || config.data.file_name().is_some_and(|name| name == "store"))
        .then_some(app_data.as_path());
    let claim = ownership::Owner::claim(data.clone(), directory, legacy, config.desktop, &stop);
    let owner = match claim.await? {
        ownership::Claim::Owned(owner) => owner,
        ownership::Claim::Stopped => return Ok(()),
        ownership::Claim::Busy(holder) => return store_in_use(config.desktop, holder),
    };
    if stop.is_cancelled() {
        return Ok(());
    }

    let local = local::Local::new(plugins.clone(), app_data);
    let backend =
        match Backend::start_plugins(Storage::Disk(config.data), PoolConfig::default(), &plugins)
            .await
        {
            Ok(backend) => backend,
            // A server started directly with --data may hold SurrealKV's lock
            // without participating in desktop store ownership.
            Err(error) if error.to_string().contains("is already locked by another") => {
                return store_in_use(config.desktop, None);
            }
            Err(error) => return Err(error.into()),
        };
    let ws = format!("ws://{address}/ws");
    let control = match owner.publish(&ws) {
        Ok(control) => control,
        Err(error) => {
            backend.close().await?;
            return Err(error);
        }
    };
    println!("Tokamak listening on {ws}");
    let serving = websocket::serve_runner(
        listener,
        backend.server().clone(),
        stop.cancelled_owned(),
        websocket::LocalAccess {
            token,
            identity: serde_json::json!({ "url": ws, "pid": std::process::id() }),
        },
        control,
        local.route(),
    )
    .await;
    local.shutdown().await;
    let closed = backend.close().await;
    serving?;
    closed?;
    Ok(())
}

fn store_in_use(desktop: bool, holder: Option<(u32, &'static str)>) -> anyhow::Result<()> {
    let detail = holder.map_or_else(String::new, |(pid, program)| {
        format!(" by {program} (PID {pid})")
    });
    let message =
        format!("Store is in use{detail}. Close the process before starting this Runner again.");
    if desktop {
        println!("{}{message}", tokamak_worker::runner::STORE_BUSY);
    }
    Err(anyhow::Error::msg(message))
}
