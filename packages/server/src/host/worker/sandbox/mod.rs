//! OS authority is installed before exec, and inherited by every descendant.
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
use super::*;

#[derive(Clone)]
pub(crate) struct Policy {
    pub read: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
    pub exec: Vec<PathBuf>,
    pub network: bool,
    pub keychain: bool,
    pub processes: bool,
    pub limits: crate::plugins::WorkerLimits,
    pub runtime_paths: Vec<PathBuf>,
}

pub(super) fn expand(path: &str) -> Result<PathBuf, String> {
    let path = if path == "~" || path.starts_with("~/") {
        directories::BaseDirs::new()
            .ok_or("Home directory unavailable")?
            .home_dir()
            .join(path.strip_prefix("~/").unwrap_or(""))
    } else {
        PathBuf::from(path)
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir))
    {
        return Err("Worker grants require absolute paths (or ~/ paths), without ..".into());
    }
    Ok(path)
}
impl Policy {
    pub(super) fn new(
        permissions: &[String],
        limits: crate::plugins::WorkerLimits,
    ) -> Result<Self, String> {
        let mut policy = Self {
            read: vec![],
            write: vec![],
            exec: vec![],
            network: false,
            keychain: false,
            processes: false,
            limits,
            runtime_paths: vec![],
        };
        for grant in permissions {
            if grant == "fs:write:selected" {
                continue;
            }
            if let Some(path) = grant.strip_prefix("fs:read:") {
                policy.read.push(expand(path)?);
            } else if let Some(path) = grant.strip_prefix("fs:write:") {
                policy.write.push(expand(path)?);
            } else if let Some(tool) = grant.strip_prefix("proc:tool:") {
                if tool.is_empty() || tool.contains('/') || tool.contains(':') {
                    return Err("Invalid proc tool name".into());
                }
                if let Some(path) = discovery::resolve(tool, &discovery::search_paths()) {
                    policy.tool(&path)?;
                }
            } else if let Some(path) = grant.strip_prefix("proc:") {
                let path = expand(path)?;
                policy.processes = true;
                // Missing optional adapters are never downloaded or executed at discovery.
                if path.is_file() {
                    policy.exec.push(path.clone());
                    policy
                        .exec
                        .push(path.canonicalize().map_err(|e| e.to_string())?);
                }
            } else if grant == "keychain" {
                policy.keychain = true;
            } else if grant == "net" || grant.strip_prefix("net:").is_some_and(|s| !s.is_empty()) {
                policy.network = true;
            }
        }
        policy.processes = !policy.exec.is_empty();
        Ok(policy)
    }
    // A tool grant includes its installed package (including bundled native
    // helpers), its shebang interpreter and a sibling Node runtime. All execute
    // rules are concrete files; directory write grants never imply execution.
    fn tool(&mut self, shim: &Path) -> Result<(), String> {
        let executable = shim.canonicalize().map_err(|e| e.to_string())?;
        self.exec.push(executable.clone());
        let mut link = shim.to_path_buf();
        for _ in 0..16 {
            if let Some(bin) = link.parent() {
                let node = bin.join("node");
                if bin.file_name().is_some_and(|s| s == "bin")
                    && node.is_file()
                    && !std::fs::symlink_metadata(&node)
                        .map_err(|e| e.to_string())?
                        .file_type()
                        .is_symlink()
                {
                    self.exec.push(node);
                    self.runtime_paths.push(bin.to_path_buf());
                }
            }
            match std::fs::read_link(&link) {
                Ok(target) => {
                    link = if target.is_absolute() {
                        target
                    } else {
                        link.parent().unwrap().join(target)
                    }
                }
                Err(_) => break,
            }
        }
        if let Some(root) = executable
            .ancestors()
            .skip(1)
            .take_while(|p| p.parent().is_some())
            .find(|p| p.join("package.json").is_file())
        {
            self.read.push(root.to_path_buf());
            fn binaries(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
                for item in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                    let item = item.map_err(|e| e.to_string())?;
                    let path = item.path();
                    let kind = item.file_type().map_err(|e| e.to_string())?;
                    if kind.is_dir() {
                        binaries(root, &path, out)?;
                    } else if kind.is_file() {
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            if item
                                .metadata()
                                .map_err(|e| e.to_string())?
                                .permissions()
                                .mode()
                                & 0o111
                                != 0
                            {
                                out.push(path);
                            }
                        }
                    } else if kind.is_symlink() {
                        if let Ok(target) = path.canonicalize() {
                            if target.starts_with(root) && target.is_file() {
                                out.push(target);
                            }
                        }
                    }
                }
                Ok(())
            }
            binaries(root, root, &mut self.exec)?;
        }
        Ok(())
    }
    pub(super) fn prepare(
        &mut self,
        bun: &Path,
        entry: &Path,
        code: &Path,
        cwd: &Path,
        temp: &Path,
    ) -> Result<(), String> {
        self.read.extend([entry.to_path_buf(), code.to_path_buf()]);
        self.write.extend([
            cwd.canonicalize().map_err(|e| e.to_string())?,
            temp.to_path_buf(),
        ]);
        self.exec
            .push(bun.canonicalize().map_err(|e| e.to_string())?);
        for path in ["/dev/null", "/dev/urandom", "/dev/random"] {
            self.read.push(path.into());
        }
        #[cfg(target_os = "linux")]
        for path in [
            "/lib",
            "/lib64",
            "/usr/lib",
            "/usr/lib64",
            "/etc/ld.so.cache",
            "/etc/ssl/certs",
            "/etc/resolv.conf",
            "/etc/hosts",
            "/etc/nsswitch.conf",
            "/etc/passwd",
            "/proc/meminfo",
            "/proc/cpuinfo",
            "/sys/devices/system/cpu",
        ] {
            self.read.push(path.into());
        }
        #[cfg(target_os = "macos")]
        for path in [
            "/System/Library",
            "/System/Volumes/Preboot/Cryptexes/OS",
            "/private/var/db/timezone",
            "/usr/share/zoneinfo",
            "/usr/share/icu",
            "/usr/lib",
            "/private/etc/ssl",
            "/private/etc/resolv.conf",
            "/private/etc/hosts",
            "/Library/Preferences/com.apple.security.plist",
            "/dev/dtracehelper",
        ] {
            self.read.push(path.into());
        }
        #[cfg(target_os = "linux")]
        for loader in [
            "/lib/ld-linux-aarch64.so.1",
            "/lib64/ld-linux-x86-64.so.2",
            "/lib/ld-musl-aarch64.so.1",
            "/lib/ld-musl-x86_64.so.1",
        ] {
            if let Ok(path) = Path::new(loader).canonicalize() {
                self.exec.push(path);
            }
        }
        self.read.extend(self.exec.iter().cloned());
        // Resolve grants now, before entering the restricted child; symlink targets
        // receive their own rule. Missing optional config paths confer no authority.
        self.read = existing(&self.read);
        self.write = existing(&self.write);
        Ok(())
    }
    pub(super) fn command(&self, bun: &Path) -> Result<tokio::process::Command, String> {
        #[cfg(target_os = "macos")]
        {
            Ok(macos::command(self, bun))
        }
        #[cfg(target_os = "linux")]
        {
            Ok(tokio::process::Command::new(bun))
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = bun;
            Err("Worker sandbox is supported only on Linux and macOS".into())
        }
    }
    pub(super) fn apply(&self, command: &mut tokio::process::Command) -> Result<Guard, String> {
        #[cfg(target_os = "linux")]
        {
            linux::apply(self, command)
        }
        #[cfg(target_os = "macos")]
        {
            macos::apply(self, command);
            Ok(Guard)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = command;
            Err("Unsupported worker sandbox".into())
        }
    }
}
fn existing(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths.iter().filter_map(|p| p.canonicalize().ok()).collect()
}
#[cfg(target_os = "linux")]
pub(super) use linux::Guard;
#[cfg(not(target_os = "linux"))]
pub(super) struct Guard;
