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

pub const STORE_BUSY: &str = "Tokamak store busy: ";
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
    Stopping,
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
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => Err("Runner is stopping".into()),
            result = state.wait_for(|state| !matches!(state, State::Starting)) => {
                result.map_err(|_| "Runner supervisor stopped".to_owned()).and_then(|state| match &*state {
                    State::Ready(endpoint) => Ok(endpoint.clone()),
                    State::Failed(error) => Err(error.clone()),
                    _ => Err("Runner is stopping".into()),
                })
            }
        }
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
        match child(&binary, &directory, &plugins, &publish, &stop).await {
            Ok(Outcome::Stop) => break,
            Ok(Outcome::StoreBusy) => {
                stop.cancelled().await;
                break;
            }
            Ok(Outcome::Retry) => {}
            Err(error) => {
                publish.send_replace(State::Failed(error));
            }
        }
        if stop.is_cancelled() {
            break;
        }
        if start.elapsed() >= Duration::from_secs(30) {
            retry = Duration::from_millis(250);
        }
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(retry) => {},
        }
        retry = (retry * 2).min(Duration::from_secs(5));
        publish.send_replace(State::Starting);
    }
    publish.send_replace(State::Stopping);
    publish.send_replace(State::Stopped);
}

enum Outcome {
    Stop,
    Retry,
    StoreBusy,
}

enum Startup {
    Ready(Endpoint),
    StoreBusy(String),
}

async fn child(
    binary: &Path,
    directory: &Path,
    plugins: &Path,
    publish: &watch::Sender<State>,
    stop: &CancellationToken,
) -> Result<Outcome, String> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(directory).await.map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| e.to_string())?;
    }
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
        if let Some(error) = line.strip_prefix(STORE_BUSY).filter(|s| s.ends_with('\n')) {
            return Ok(Startup::StoreBusy(error.trim_end().to_owned()));
        }
        let address: SocketAddr = line
            .trim_end()
            .strip_prefix(READY)
            .and_then(|s| s.strip_suffix("/ws"))
            .and_then(|s| s.parse::<SocketAddr>().ok())
            .filter(|a| a.ip().is_loopback() && a.port() != 0)
            .ok_or_else(|| std::io::Error::other("Runner exited or sent invalid readiness"))?;
        Ok::<_, std::io::Error>(Startup::Ready(Endpoint {
            http: format!("http://{address}"),
            ws: format!("ws://{address}/ws"),
            token,
        }))
    };

    let startup = tokio::select! {
        biased;
        _ = stop.cancelled() => None,
        ready = tokio::time::timeout(START_TIMEOUT, ready) => Some(ready),
    };
    // Read through EOF even after readiness; inherited stdout must not fill a
    // pipe and stall the Runner or one of its children.
    let stdout = AbortOnDropHandle::new(tokio::spawn(async move {
        let _ = tokio::io::copy(&mut output, &mut tokio::io::sink()).await;
    }));
    let (outcome, state) = match startup {
        None => (Outcome::Stop, State::Stopping),
        Some(Ok(Ok(Startup::Ready(endpoint)))) => {
            publish.send_replace(State::Ready(endpoint));
            tokio::select! {
                biased;
                _ = stop.cancelled() => (Outcome::Stop, State::Stopping),
                reason = child.exited() => (Outcome::Retry, State::Failed(format!("Runner {reason}; inspect runner.log"))),
            }
        }
        Some(Ok(Ok(Startup::StoreBusy(error)))) => (Outcome::StoreBusy, State::Failed(error)),
        Some(Ok(Err(error))) => (
            Outcome::Retry,
            State::Failed(format!("{error}; inspect runner.log")),
        ),
        Some(Err(_)) => (
            Outcome::Retry,
            State::Failed("Runner did not become ready; inspect runner.log".into()),
        ),
    };
    // Invalidate the endpoint before waiting for the process group and its pipes.
    publish.send_replace(state);
    drop(input);
    if matches!(outcome, Outcome::Stop | Outcome::StoreBusy) {
        let _ = tokio::time::timeout(STOP_TIMEOUT, child.exited()).await;
    }
    child.stop().await;
    let _ = tokio::time::timeout(Duration::from_millis(500), async {
        let _ = tokio::join!(stdout, drain);
    })
    .await;
    Ok(outcome)
}

pub fn new_secret() -> Result<String, String> {
    use std::fmt::Write;
    let mut secret = [0; 32];
    getrandom::fill(&mut secret).map_err(|e| e.to_string())?;
    let mut token = String::with_capacity(64);
    for byte in secret {
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn fixture(dir: &Path, body: &str) -> Runner {
        let binary = dir.join("fake-runner");
        std::fs::write(
            &binary,
            format!("#!/bin/sh\ncd \"$(dirname \"$3\")\" || exit 1\nIFS= read -r secret || exit 1\n{body}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        Runner::start(binary, dir.to_owned(), dir.to_owned())
    }

    async fn marker(path: &Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("missing {}", path.display()));
    }

    fn assert_exited(dir: &Path) {
        let pid: libc::pid_t = std::fs::read_to_string(dir.join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: Signal zero probes the recorded test process without signalling it.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "child {pid} was not reaped"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[tokio::test]
    async fn shutdown_during_startup_closes_and_reaps_the_unready_child() {
        let dir = tempfile::tempdir().unwrap();
        let runner = fixture(
            dir.path(),
            "echo $$ > pid; touch starting; cat >/dev/null; touch closed",
        );
        marker(&dir.path().join("starting")).await;
        runner.shutdown().await;
        assert!(dir.path().join("closed").exists());
        assert_exited(dir.path());
    }

    #[tokio::test]
    async fn shutdown_during_backoff_never_launches_another_child() {
        let dir = tempfile::tempdir().unwrap();
        let runner = fixture(
            dir.path(),
            "echo $$ > pid; echo attempt >> attempts; exit 1",
        );
        assert!(runner.endpoint().await.is_err());
        runner.shutdown().await;
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("attempts")).unwrap(),
            "attempt\n"
        );
        assert_exited(dir.path());
    }

    #[tokio::test]
    async fn crash_invalidates_readiness_before_the_log_pipe_drains() {
        const HOLD: &str = "TOKAMAK_TEST_HOLD_RUNNER_LOG_PIPE";
        if std::env::var_os(HOLD).is_some() {
            // SAFETY: The fixture starts this subprocess as a non-leader. Its
            // own session lets it retain the stderr pipe past group cleanup.
            assert_ne!(unsafe { libc::setsid() }, -1);
            std::fs::write("holding", "").unwrap();

            let _ =
                tokio::time::timeout(Duration::from_secs(4), marker(Path::new("release"))).await;
            std::fs::write("released", "").unwrap();
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            std::env::current_exe().unwrap(),
            dir.path().join("pipe-holder"),
        )
        .unwrap();
        let runner = fixture(
            dir.path(),
            r#"echo 'Tokamak listening on ws://127.0.0.1:43210/ws'
TOKAMAK_TEST_HOLD_RUNNER_LOG_PIPE=1 ./pipe-holder --exact runner::tests::crash_invalidates_readiness_before_the_log_pipe_drains >/dev/null &
while [ ! -f crash ]; do sleep 0.01; done
exit 1"#,
        );
        assert!(runner.endpoint().await.is_ok());
        marker(&dir.path().join("holding")).await;
        std::fs::write(dir.path().join("crash"), "").unwrap();
        let mut state = runner.state.clone();
        // The supervisor allows 500ms to drain stderr. The old endpoint must
        // be gone before that timeout, while the holder still owns the pipe.
        let invalidated = tokio::time::timeout(Duration::from_millis(400), async {
            state
                .wait_for(|state| matches!(state, State::Failed(_)))
                .await
                .unwrap();
            runner.endpoint().await.is_err()
        })
        .await;
        std::fs::write(dir.path().join("release"), "").unwrap();
        marker(&dir.path().join("released")).await;
        runner.shutdown().await;
        assert!(invalidated.unwrap());
    }

    #[tokio::test]
    async fn ready_endpoint_is_unavailable_while_shutdown_is_still_cleaning_up() {
        let dir = tempfile::tempdir().unwrap();
        let runner = fixture(
            dir.path(),
            r#"echo $$ > pid
echo 'Tokamak listening on ws://127.0.0.1:43210/ws'
head -c 1048576 /dev/zero
touch drained
cat >/dev/null
touch closing
while [ ! -f finish ]; do sleep 0.01; done"#,
        );
        assert!(runner.endpoint().await.is_ok());
        marker(&dir.path().join("drained")).await;
        let probe = async {
            marker(&dir.path().join("closing")).await;
            assert!(matches!(*runner.state.borrow(), State::Stopping));
            assert!(runner.endpoint().await.is_err());
            std::fs::write(dir.path().join("finish"), "").unwrap();
        };
        tokio::join!(runner.shutdown(), probe);
        assert_exited(dir.path());
    }
}
