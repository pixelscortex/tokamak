//! Desktop ownership of a Runner. This never opens the workspace or launches plugins.

use crate::Process;
use serde::Serialize;
use std::{
    ffi::OsStr,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::watch,
};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

const READY: &str = "Tokamak listening on ws://";
const START_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
pub struct Endpoint {
    pub http: String,
    pub ws: String,
    pub token: String,
}

enum State {
    Starting,
    Ready(Endpoint),
    Failed(String),
    Stopped,
}

pub struct Runner {
    state: watch::Receiver<State>,
    stop: CancellationToken,
}

impl Runner {
    /// Starts one child and restarts it if it exits before being asked to stop.
    pub fn start(binary: PathBuf, directory: PathBuf, plugins: PathBuf) -> Self {
        let (publish, state) = watch::channel(State::Starting);
        let stop = CancellationToken::new();
        tokio::spawn(supervise(binary, directory, plugins, publish, stop.clone()));
        Self { state, stop }
    }

    pub async fn endpoint(&self) -> Result<Endpoint, String> {
        let mut state = self.state.clone();
        state
            .wait_for(|state| !matches!(state, State::Starting))
            .await
            .map_err(|_| "Runner supervisor stopped".to_owned())
            .and_then(|state| match &*state {
                State::Ready(endpoint) => Ok(endpoint.clone()),
                State::Failed(error) => Err(error.clone()),
                _ => Err("Runner is stopping".into()),
            })
    }

    /// Closes the child's liveness pipe, then waits for exit or forced cleanup.
    pub async fn shutdown(&self) {
        self.stop.cancel();
        let _ = self
            .state
            .clone()
            .wait_for(|s| matches!(s, State::Stopped))
            .await;
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

async fn supervise(
    binary: PathBuf,
    directory: PathBuf,
    plugins: PathBuf,
    publish: watch::Sender<State>,
    stop: CancellationToken,
) {
    let mut retry = Duration::from_millis(250);
    while !stop.is_cancelled() {
        let start = tokio::time::Instant::now();
        let reason = run_child(&binary, &directory, &plugins, &publish, &stop).await;
        if stop.is_cancelled() {
            break;
        }
        if start.elapsed() >= Duration::from_secs(30) {
            retry = Duration::from_millis(250);
        }
        publish.send_replace(State::Failed(reason));
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(retry) => {},
        }
        retry = (retry * 2).min(Duration::from_secs(5));
        publish.send_replace(State::Starting);
    }
    publish.send_replace(State::Stopped);
}

async fn run_child(
    binary: &Path,
    directory: &Path,
    plugins: &Path,
    publish: &watch::Sender<State>,
    stop: &CancellationToken,
) -> String {
    match child(binary, directory, plugins, publish, stop).await {
        Ok(reason) | Err(reason) => reason,
    }
}

async fn child(
    binary: &Path,
    directory: &Path,
    plugins: &Path,
    publish: &watch::Sender<State>,
    stop: &CancellationToken,
) -> Result<String, String> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(directory).await.map_err(|e| e.to_string())?;
    let mut log = tokio::fs::OpenOptions::new();
    log.create(true).append(true);
    #[cfg(unix)]
    log.mode(0o600);
    let mut log = log
        .open(directory.join("runner.log"))
        .await
        .map_err(|e| e.to_string())?;

    let token = new_secret()?;
    let data = directory.join("store");
    let mut child = Process::launch_runner(
        binary,
        &[
            OsStr::new("--desktop"),
            OsStr::new("--data"),
            data.as_os_str(),
            OsStr::new("--plugins"),
            plugins.as_os_str(),
        ],
    )?;
    let (mut input, output, mut errors) = child.pipes()?;
    let drain = AbortOnDropHandle::new(tokio::spawn(async move {
        let _ = tokio::io::copy(&mut errors, &mut log).await;
    }));
    let mut output = BufReader::new(output);
    let ready = async {
        input.write_all(format!("{token}\n").as_bytes()).await?;
        input.flush().await?;
        let mut line = String::new();
        (&mut output).take(256).read_line(&mut line).await?;
        let address: SocketAddr = line
            .trim_end()
            .strip_prefix(READY)
            .and_then(|s| s.strip_suffix("/ws"))
            .and_then(|s| s.parse::<SocketAddr>().ok())
            .filter(|a| a.ip().is_loopback() && a.port() != 0)
            .ok_or_else(|| std::io::Error::other("Runner exited or sent invalid readiness"))?;
        Ok::<_, std::io::Error>(Endpoint {
            http: format!("http://{address}"),
            ws: format!("ws://{address}/ws"),
            token,
        })
    };

    let result = tokio::select! {
        _ = stop.cancelled() => Ok("Runner stopped".into()),
        ready = tokio::time::timeout(START_TIMEOUT, ready) => match ready {
            Ok(Ok(endpoint)) => {
                publish.send_replace(State::Ready(endpoint));
                tokio::select! {
                    _ = stop.cancelled() => Ok("Runner stopped".into()),
                    reason = child.exited() => Err(format!("Runner {reason}; inspect runner.log")),
                }
            }
            Ok(Err(error)) => Err(format!("{error}; inspect runner.log")),
            Err(_) => Err("Runner did not become ready; inspect runner.log".into()),
        },
    };
    // EOF requests graceful shutdown. The guardian/job still contains the
    // process if we die here or the Runner cannot finish shutting down.
    drop(input);
    if result.is_ok() {
        let _ = tokio::time::timeout(STOP_TIMEOUT, child.exited()).await;
    }
    child.stop().await;
    let _ = tokio::time::timeout(Duration::from_millis(500), drain).await;
    result
}

fn new_secret() -> Result<String, String> {
    use std::fmt::Write;
    let mut secret = [0; 32];
    getrandom::fill(&mut secret).map_err(|e| e.to_string())?;
    let mut token = String::with_capacity(64);
    for byte in secret {
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}
