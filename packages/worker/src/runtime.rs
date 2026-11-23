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
    pub fn name(&self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::QuickJs => "quickjs",
        }
    }

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
    if !supported {
        return Ok(LocalRuntime::Bun);
    }

    match value {
        Some(value) if value == "bun" => Ok(LocalRuntime::Bun),
        None => Ok(LocalRuntime::QuickJs),
        Some(value) if value == "quickjs" => Ok(LocalRuntime::QuickJs),
        _ => Err("TOKAMAK_PLUGIN_RUNTIME must be bun or quickjs".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{LocalRuntime, select};
    use std::ffi::OsStr;

    #[test]
    fn supported_platform_selects_quickjs_by_default_and_validates_overrides() {
        assert_eq!(select(None, true), Ok(LocalRuntime::QuickJs));
        assert_eq!(select(Some(OsStr::new("bun")), true), Ok(LocalRuntime::Bun));
        assert_eq!(
            select(Some(OsStr::new("quickjs")), true),
            Ok(LocalRuntime::QuickJs)
        );

        for value in ["other", "", "Bun", "QuickJS", " bun", "quickjs "] {
            assert_eq!(
                select(Some(OsStr::new(value)), true).unwrap_err(),
                "TOKAMAK_PLUGIN_RUNTIME must be bun or quickjs"
            );
        }
    }

    #[test]
    fn unsupported_platform_always_selects_bun() {
        for value in [
            None,
            Some("bun"),
            Some("quickjs"),
            Some("other"),
            Some(""),
            Some(" Bun "),
        ] {
            assert_eq!(select(value.map(OsStr::new), false), Ok(LocalRuntime::Bun));
        }
    }
}
