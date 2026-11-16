use std::path::{Path, PathBuf};

pub(super) fn search_paths() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    // Static locations keep listing cheap, including when Finder omitted the
    // shell PATH. Never launch npm (or a downloading npx/bunx) during discovery.
    for directory in [
        "~/.local/bin",
        "~/.npm-global/bin",
        "~/.bun/bin",
        "~/.local/share/vite-plus/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "~/.volta/bin",
    ] {
        if let Some(relative) = directory.strip_prefix("~/") {
            if let Some(home) = &home {
                paths.push(home.join(relative));
            }
        } else {
            paths.push(directory.into());
        }
    }
    paths
}

pub(super) fn resolve(command: &str, paths: &[PathBuf]) -> Option<PathBuf> {
    let command = Path::new(command);
    let candidates = if command.components().count() > 1 || command.is_absolute() {
        vec![command.to_path_buf()]
    } else {
        paths
            .iter()
            .filter(|path| path.is_absolute())
            .map(|path| path.join(command))
            .collect()
    };
    candidates.into_iter().find_map(|path| {
        if !path.is_absolute() {
            return None;
        }
        let directory = std::fs::metadata(path.parent()?).ok()?;
        if !directory.is_dir() {
            return None;
        }
        // Follow symlinks when checking the final executable, while retaining
        // the shim path below for toolchains that depend on its location.
        let metadata = std::fs::metadata(&path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid has no preconditions or memory effects.
            let uid = unsafe { libc::geteuid() };
            if directory.mode() & 0o022 != 0
                || metadata.mode() & 0o022 != 0
                || metadata.mode() & 0o111 == 0
                || (metadata.uid() != uid && metadata.uid() != 0)
            {
                return None;
            }
        }
        // Keep a symlink's toolchain directory (Volta and npm shims rely on it).
        Some(path)
    })
}

/// Resolve toolchain shims outside the sandbox; execute only the actual Bun
/// binary inside it, so a shim cannot require undeclared process authority.
pub(super) fn bun() -> Option<PathBuf> {
    static BUN: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    BUN.get_or_init(|| {
        let shim = resolve("bun", &search_paths())?;
        let output = std::process::Command::new(shim)
            .args(["--print", "process.execPath"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8(output.stdout).ok()?;
        resolve(path.trim(), &[]).and_then(|p| p.canonicalize().ok())
    })
    .clone()
}
