use std::path::{Path, PathBuf};
use tauri::Manager;
use tokamak_worker::runner::{Endpoint, Folders, Runner};

pub struct Host(Result<Runner, String>);

pub fn start(app: &tauri::AppHandle) {
    let runner = configuration().map(|(binary, folders)| {
        // The supervisor uses the Tauri runtime, not the window's lifetime.
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        Runner::start(binary, folders.data, folders.plugins)
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
    host.0.as_ref().map_err(Clone::clone)?.endpoint().await
}

pub async fn shutdown(app: &tauri::AppHandle) {
    if let Ok(runner) = &app.state::<Host>().0 {
        runner.shutdown().await;
    }
}
