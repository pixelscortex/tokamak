use std::path::{Path, PathBuf};
use tauri::Manager;
use tokamak_worker::runner::{Endpoint, Runner};

pub struct Host(Result<Runner, String>);

pub fn start(app: &tauri::AppHandle) {
    let runner = configuration(app).map(|(binary, directory, plugins)| {
        // The supervisor uses the Tauri runtime, not the window's lifetime.
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        Runner::start(binary, directory, plugins)
    });
    app.manage(Host(runner));
}

fn configuration(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let directory = std::env::var_os("TOKAMAK_SERVER_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            directories::ProjectDirs::from("com", "pixelscortex", "Tokamak")
                .map(|paths| paths.data_local_dir().to_owned())
        })
        .ok_or("Cannot locate application data directory")?;
    let plugins = if let Some(directory) = std::env::var_os("TOKAMAK_PLUGIN_DIR") {
        PathBuf::from(directory)
    } else if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("plugins")
    };
    Ok((binary()?, directory, plugins))
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
    host.0.as_ref().map_err(Clone::clone)?.endpoint().await
}

pub async fn shutdown(app: &tauri::AppHandle) {
    if let Ok(runner) = &app.state::<Host>().0 {
        runner.shutdown().await;
    }
}
