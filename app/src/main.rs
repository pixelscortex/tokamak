//! Desktop owns a client connection, never backend execution or storage.
mod socket;

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let directory = std::env::var_os("TOKAMAK_SERVER_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            directories::ProjectDirs::from("com", "pixelscortex", "Tokamak")
                .map(|p| p.data_local_dir().to_owned())
        })
        .ok_or("Cannot locate application data directory")?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let connection = runtime.block_on(socket::connect(&directory))?;
    let (requests, receiver) = socket::admission();
    let (host, ready) = tokio::sync::oneshot::channel();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let worker = runtime.spawn(socket::serve(connection, receiver, ready, stopped));
    let result = render::launch_connected(
        include_str!("../dist/shell.html"),
        include_str!("../dist/ui.js"),
        "Tokamak · Todo",
        Some(requests),
        move |sender| {
            let _ = host.send(sender);
        },
    );
    let _ = stop.send(());
    runtime.block_on(worker)?;
    result?;
    Ok(())
}
