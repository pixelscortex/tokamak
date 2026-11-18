use std::path::{Path, PathBuf};

pub(super) fn search_paths() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    #[cfg(windows)]
    let directories = ["~/.bun/bin"];
    // Static locations keep listing cheap, including when Finder omitted the
    // shell PATH. Never launch npm (or a downloading npx/bunx) during discovery.
    #[cfg(not(windows))]
    let directories = [
        "~/.local/bin",
        "~/.npm-global/bin",
        "~/.bun/bin",
        "~/.local/share/vite-plus/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "~/.volta/bin",
    ];
    for directory in directories {
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
    #[cfg(windows)]
    let executable = command.with_extension("exe");
    #[cfg(windows)]
    let command = executable.as_path();
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
