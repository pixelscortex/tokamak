//! The desktop store uses the same OS lock as the detached desktop server.

use server::local_endpoint::{
    self, LEGACY_DISCOVERY, LEGACY_TOKEN, RUNNER_CONTROL, RUNNER_DISCOVERY,
};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, Write as _},
    path::{Path, PathBuf},
    time::Duration,
};
use tokamak_worker::runner::new_secret;
use tokio_util::sync::CancellationToken;

pub struct Owner {
    _store: File,
    _legacy: Option<File>,
    directory: PathBuf,
    store: PathBuf,
}

pub enum Claim {
    Owned(Owner),
    Busy(Option<(u32, &'static str)>),
    Stopped,
}

pub fn private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn open_lock(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

impl Owner {
    pub async fn claim(
        store: PathBuf,
        directory: &Path,
        legacy: Option<&Path>,
        replace: bool,
        stop: &CancellationToken,
    ) -> anyhow::Result<Claim> {
        let file = open_lock(&store.join("runner-owner.lock"))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                let holder = fs::read_to_string(store.join("runner.pid"))
                    .ok()
                    .and_then(|value| value.parse().ok());
                return Ok(Claim::Busy(holder.map(|pid| (pid, "tokamak-runner"))));
            }
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
        // Old desktop builds used <app data>/store and a sibling lock. Hold
        // that lock too, so an old build cannot open the store after migration.
        let legacy_lock = if let Some(directory) = legacy {
            match claim_legacy(directory, replace, stop).await? {
                LegacyClaim::Owned(lock) => Some(lock),
                LegacyClaim::Busy(pid) => {
                    return Ok(Claim::Busy(pid.map(|pid| (pid, "tokamak-server"))));
                }
                LegacyClaim::Stopped => return Ok(Claim::Stopped),
            }
        } else {
            None
        };
        let owner = Self {
            _store: file,
            _legacy: legacy_lock,
            directory: directory.to_owned(),
            store,
        };
        // Clear crash leftovers while holding ownership, before replacing them.
        owner.clear();
        atomic_write(
            &owner.store,
            "runner.pid",
            std::process::id().to_string().as_bytes(),
        )?;
        Ok(Claim::Owned(owner))
    }

    pub fn publish(&self, ws: &str) -> anyhow::Result<String> {
        let control = new_secret().map_err(anyhow::Error::msg)?;
        atomic_write(&self.directory, RUNNER_CONTROL, control.as_bytes())?;
        let descriptor = serde_json::json!({ "url": ws, "pid": std::process::id() });
        atomic_write(
            &self.directory,
            RUNNER_DISCOVERY,
            descriptor.to_string().as_bytes(),
        )?;
        Ok(control)
    }

    fn clear(&self) {
        for name in [RUNNER_DISCOVERY, RUNNER_CONTROL] {
            let _ = fs::remove_file(self.directory.join(name));
        }
        let _ = fs::remove_file(self.store.join("runner.pid"));
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.clear();
    }
}

fn atomic_write(directory: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    // NamedTempFile creates files with mode 0600 on Unix.
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(bytes)?;
    file.persist(directory.join(name))?;
    Ok(())
}

enum LegacyClaim {
    Owned(File),
    Busy(Option<u32>),
    Stopped,
}

async fn claim_legacy(
    directory: &Path,
    replace: bool,
    stop: &CancellationToken,
) -> io::Result<LegacyClaim> {
    let lock = open_lock(&directory.join("server-owner.lock"))?;
    match lock.try_lock() {
        Ok(()) => return Ok(LegacyClaim::Owned(lock)),
        Err(TryLockError::WouldBlock) => {}
        Err(TryLockError::Error(error)) => return Err(error),
    }
    if !replace {
        // Only the desktop takes a store over. A Runner started by hand
        // leaves the server that holds the store running and names it.
        return Ok(LegacyClaim::Busy(Legacy::recorded_pid(directory)));
    }
    let Some(previous) = Legacy::find(directory).await else {
        // The old process may already have exited during the health probe.
        return match lock.try_lock() {
            Ok(()) => Ok(LegacyClaim::Owned(lock)),
            Err(TryLockError::WouldBlock) => Ok(LegacyClaim::Busy(None)),
            Err(TryLockError::Error(error)) => Err(error),
        };
    };
    if previous.release(&lock, stop).await? {
        eprintln!("Replaced the previous desktop server");
        Ok(LegacyClaim::Owned(lock))
    } else if stop.is_cancelled() {
        Ok(LegacyClaim::Stopped)
    } else {
        Ok(LegacyClaim::Busy(Some(previous.pid)))
    }
}

struct Legacy {
    client: reqwest::Client,
    http: reqwest::Url,
    token: String,
    identity: serde_json::Value,
    pid: u32,
}

impl Legacy {
    /// The PID the holder wrote, without contacting it.
    fn recorded_pid(directory: &Path) -> Option<u32> {
        let identity: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join(LEGACY_DISCOVERY)).ok()?).ok()?;
        let pid: u32 = identity["pid"].as_u64()?.try_into().ok()?;
        (pid != 0 && running(pid)).then_some(pid)
    }

    async fn find(directory: &Path) -> Option<Self> {
        let identity: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join(LEGACY_DISCOVERY)).ok()?).ok()?;
        let pid = identity["pid"].as_u64()?.try_into().ok()?;
        // A descriptor left by an earlier run names a port that another
        // program may have since taken. Its process is gone, so the token
        // is never sent there.
        if !running(pid) {
            return None;
        }
        let hash = identity["bundleHash"].as_str()?;
        if pid == 0 || hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let http = local_endpoint::http_url(identity["url"].as_str()?).ok()?;
        let token = local_endpoint::private_token(&directory.join(LEGACY_TOKEN)).ok()?;
        let client = local_endpoint::client(Duration::from_secs(1)).ok()?;
        let legacy = Self {
            client,
            http,
            token,
            identity,
            pid,
        };
        legacy.verified().await.then_some(legacy)
    }

    async fn verified(&self) -> bool {
        let mut url = self.http.clone();
        url.set_path("/health");
        let Ok(response) = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
        else {
            return false;
        };
        response
            .json::<serde_json::Value>()
            .await
            .is_ok_and(|actual| actual == self.identity)
    }

    async fn release(&self, lock: &File, stop: &CancellationToken) -> io::Result<bool> {
        if stop.is_cancelled() {
            return Ok(false);
        }
        let mut url = self.http.clone();
        url.set_path("/shutdown");
        let _ = self.client.post(url).bearer_auth(&self.token).send().await;
        // The old server holds this lock through database close and discovery
        // cleanup. Acquiring it is a stronger handoff than probing a reused PID.
        if wait_for_lock(lock, stop, Duration::from_secs(5)).await? {
            return Ok(true);
        }
        if stop.is_cancelled() {
            return Ok(false);
        }
        #[cfg(unix)]
        if let Ok(pid) = libc::pid_t::try_from(self.pid)
            && pid > 0
            && self.verified().await
            && !stop.is_cancelled()
        {
            // SAFETY: Authenticated health still identifies this exact legacy PID.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        wait_for_lock(lock, stop, Duration::from_secs(15)).await
    }
}

/// Whether a process with this PID exists. Windows has no cheap probe here,
/// so it relies on the authenticated health check alone.
fn running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: Signal 0 checks for existence and delivers nothing.
        pid > 0
            && (unsafe { libc::kill(pid, 0) } == 0
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    #[cfg(not(unix))]
    {
        pid != 0
    }
}

async fn wait_for_lock(lock: &File, stop: &CancellationToken, limit: Duration) -> io::Result<bool> {
    let acquire = async {
        loop {
            match lock.try_lock() {
                Ok(()) => return Ok(true),
                Err(TryLockError::WouldBlock) => {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
    };
    tokio::select! {
        biased;
        _ = stop.cancelled() => Ok(false),
        result = tokio::time::timeout(limit, acquire) => result.unwrap_or(Ok(false)),
    }
}
