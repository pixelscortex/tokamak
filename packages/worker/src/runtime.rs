use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
pub enum LocalRuntime {
    Bun,
    QuickJs,
}

impl LocalRuntime {
    pub fn selected() -> Result<Self, String> {
        select(
            std::env::var_os("TOKAMAK_PLUGIN_RUNTIME").as_deref(),
            cfg!(any(target_os = "macos", target_os = "linux")),
        )
    }

    pub fn host_path(executable: &Path) -> Result<PathBuf, String> {
        let path = std::env::var_os("TOKAMAK_PLUGIN_HOST").map_or_else(
            || executable.with_file_name("tokamak-plugin-host"),
            PathBuf::from,
        );
        let missing = || format!("Could not find the plugin host at {}", path.display());
        let resolved = path
            .canonicalize()
            .map_err(|error| format!("{}: {error}", missing()))?;
        if !resolved.is_file() {
            return Err(missing());
        }
        Ok(resolved)
    }
}

fn select(value: Option<&OsStr>, supported: bool) -> Result<LocalRuntime, String> {
    if !supported || value.is_none() || value == Some(OsStr::new("bun")) {
        Ok(LocalRuntime::Bun)
    } else if value == Some(OsStr::new("quickjs")) {
        Ok(LocalRuntime::QuickJs)
    } else {
        Err("TOKAMAK_PLUGIN_RUNTIME must be bun or quickjs".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{LocalRuntime, select};
    use std::ffi::OsStr;

    #[test]
    fn local_runtime_selection_used_by_the_desktop_launcher() {
        assert_eq!(select(None, true), Ok(LocalRuntime::Bun));
        assert_eq!(select(Some(OsStr::new("bun")), true), Ok(LocalRuntime::Bun));
        assert_eq!(
            select(Some(OsStr::new("quickjs")), true),
            Ok(LocalRuntime::QuickJs)
        );
        assert_eq!(
            select(Some(OsStr::new("quickjs")), false),
            Ok(LocalRuntime::Bun)
        );
        assert_eq!(
            select(Some(OsStr::new("other")), true).unwrap_err(),
            "TOKAMAK_PLUGIN_RUNTIME must be bun or quickjs"
        );
    }
}
