use std::path::PathBuf;

pub fn search_paths() -> Vec<PathBuf> {
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
