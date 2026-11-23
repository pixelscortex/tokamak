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

pub fn configured_heap_bytes(variable: &str) -> Result<usize, String> {
    heap_bytes(variable, 256)
}

pub fn configured_action_heap_bytes() -> Result<usize, String> {
    heap_bytes("TOKAMAK_ACTION_HEAP_MIB", 64)
}

fn heap_bytes(variable: &str, default_mib: usize) -> Result<usize, String> {
    let Some(value) = std::env::var_os(variable) else {
        return Ok(default_mib * 1024 * 1024);
    };
    value
        .to_str()
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|mib| *mib != 0)
        .and_then(|mib| mib.checked_mul(1024 * 1024))
        .ok_or_else(|| format!("{variable} must be a positive integer in MiB"))
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
