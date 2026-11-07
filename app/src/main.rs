//! The only desktop entry: start embedded storage/workers, then run the CPU
//! native shell on the main thread. Feature code is bundled TypeScript only.
mod connection;

use directories::ProjectDirs;
use runtime::{Bundle, PoolConfig};
use server::{Backend, BackendConfig, data::Storage};
use std::sync::Arc;
use tokio::sync::oneshot;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directories = ProjectDirs::from("com", "pixelscortex", "Tokamak")
        .ok_or("Cannot locate the application data directory")?;
    let data = directories.data_local_dir();
    std::fs::create_dir_all(data)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let bundle = Arc::new(Bundle::new(
        include_str!("../dist/bundle.js"),
        Some(include_str!("../dist/bundle.js.map")),
    )?);
    let backend = runtime.block_on(Backend::start(BackendConfig {
        storage: Storage::Disk(data.join("store")),
        bundle,
        javascript: PoolConfig::default(),
    }))?;
    let session = match runtime.block_on(backend.connect()) {
        Ok(session) => session,
        Err(error) => {
            runtime.block_on(backend.close())?;
            return Err(error.into());
        }
    };
    let (requests, receiver) = connection::admission();
    let (host, ready) = oneshot::channel();
    let (stop, stopped) = oneshot::channel();
    let worker = runtime.spawn(connection::serve(
        backend, session, receiver, ready, stopped,
    ));
    let result = render::launch_connected(
        include_str!("../dist/shell.html"),
        include_str!("../dist/ui.js"),
        "Tokamak · Todo",
        Some(requests),
        move |sender| {
            let _ = host.send(sender);
        },
    );
    // Window teardown closes client promises/subscriptions on its own UI owner.
    // Join the backend drain even when creating/running the window failed.
    let _ = stop.send(());
    runtime.block_on(worker)??;
    result?;
    Ok(())
}
