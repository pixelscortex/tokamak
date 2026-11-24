#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::{Path, PathBuf};

const WINDOWS_PLUGIN_ERROR: &str = "Plugin code is not supported on Windows yet.";

pub fn require_plugin_platform(platform: &str) -> Result<(), &'static str> {
    match platform {
        "macos" | "linux" => Ok(()),
        _ => Err(unsupported_plugin_platform(platform)),
    }
}

pub(super) fn unsupported_plugin_platform(platform: &str) -> &'static str {
    if platform == "windows" {
        WINDOWS_PLUGIN_ERROR
    } else {
        "Plugin code is available on macOS and Linux."
    }
}

#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
/// Resolve and verify the host before a QuickJS Runner starts listening.
pub async fn require_local_host(executable: &Path) -> Result<PathBuf, String> {
    let path = host_path(executable)?;
    let failure = |reason: &str| {
        format!(
            "Runner requires a plugin host with local capability at {}: {reason}",
            path.display()
        )
    };
    let mut command = tokio::process::Command::new(&path);
    command
        .arg("--capabilities")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = super::spawn_child(&mut command, None);
    let child = child.map_err(|error| failure(&error.to_string()))?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .map_err(|_| failure("capability check timed out"))?
        .map_err(|error| failure(&error.to_string()))?;
    if !output.status.success() {
        return Err(failure(&format!(
            "capability check exited with {}",
            output.status
        )));
    }
    if !String::from_utf8_lossy(&output.stdout)
        .split_ascii_whitespace()
        .any(|name| name == "local")
    {
        return Err(failure("host did not advertise local capability"));
    }
    Ok(path)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn host_path(executable: &Path) -> Result<PathBuf, String> {
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

#[cfg(feature = "local-runtime")]
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

#[cfg(test)]
mod tests {
    use super::require_plugin_platform;

    #[test]
    fn plugin_calls_report_the_windows_limitation() {
        assert_eq!(
            require_plugin_platform("windows"),
            Err("Plugin code is not supported on Windows yet.")
        );
        assert_eq!(require_plugin_platform("macos"), Ok(()));
        assert_eq!(require_plugin_platform("linux"), Ok(()));
    }
}
