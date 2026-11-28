use std::path::{Path, PathBuf};
use tauri::Manager;
use tokamak_worker::runner::{Endpoint, Folders, Runner};

/// The Runner, and the plugins folder it scans (for "Reveal in Finder").
pub struct Host(Result<(Runner, PathBuf), String>);

pub fn start(app: &tauri::AppHandle) {
    let runner = configuration().map(|(binary, folders)| {
        // The supervisor uses the Tauri runtime, not the window's lifetime.
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        let plugins = folders.plugins.clone();
        (
            Runner::start(binary, folders.data, folders.plugins),
            plugins,
        )
    });
    app.manage(Host(runner));
}

fn configuration() -> Result<(PathBuf, Folders), String> {
    let binary = binary()?;
    let folders = Folders::resolve(
        cfg!(debug_assertions),
        std::env::var_os("TOKAMAK_SERVER_DIR").map(PathBuf::from),
        std::env::var_os("TOKAMAK_PLUGIN_DIR").map(PathBuf::from),
        |name| {
            directories::ProjectDirs::from("com", "pixelscortex", name)
                .map(|paths| paths.data_local_dir().to_owned())
        },
    )?;
    Ok((binary, folders))
}

fn binary() -> Result<PathBuf, String> {
    let name = format!("tokamak-runner{}", std::env::consts::EXE_SUFFIX);
    if cfg!(debug_assertions) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
        for profile in ["debug", "release"] {
            let path = root.join(profile).join(&name);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    let path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(name);
    if !path.is_file() {
        return Err("Tokamak Runner binary is missing; run the app preparation script".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn tokamak_endpoint(host: tauri::State<'_, Host>) -> Result<Endpoint, String> {
    host.0.as_ref().map_err(Clone::clone)?.0.endpoint().await
}

/// Opens the Runner's plugins folder in the system file manager (Settings → Plugins).
/// It takes no path: the window can reveal this one folder and nothing else.
#[tauri::command]
pub async fn reveal_plugins_folder(host: tauri::State<'_, Host>) -> Result<(), String> {
    let folder = host.0.as_ref().map_err(Clone::clone)?.1.clone();
    tauri::async_runtime::spawn_blocking(move || reveal(&folder))
        .await
        .map_err(|_| "Could not open the plugins folder".to_owned())?
}

fn reveal(folder: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";

    let status = std::process::Command::new(program)
        .arg(folder)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "Could not open the plugins folder".to_owned())?;
    // Explorer can delegate to an existing process and exit with code 1.
    if status.success() || (cfg!(target_os = "windows") && status.code() == Some(1)) {
        Ok(())
    } else {
        Err("Could not open the plugins folder".to_owned())
    }
}

pub async fn shutdown(app: &tauri::AppHandle) {
    if let Ok((runner, _)) = &app.state::<Host>().0 {
        runner.shutdown().await;
    }
}
