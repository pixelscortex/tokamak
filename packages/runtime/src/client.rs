//! Native UI host and bounded client drain; never owns server/storage lifetime.
pub mod connection;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub struct ClientConfig<'a> {
    pub title: &'a str,
    pub shell: &'a str,
    pub ui: &'a str,
    pub window_size: (u32, u32),
}

/// UI-only clients do not discover or connect to a backend.
pub fn run_ui(config: ClientConfig<'_>) -> Result<(), Error> {
    render::launch_window(
        config.shell,
        config.ui,
        config.title,
        config.window_size,
        None,
        |_| {},
    )?;
    Ok(())
}

pub fn run(config: ClientConfig<'_>) -> Result<(), Error> {
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
    let socket = runtime.block_on(connection::connect(&directory))?;
    let (requests, receiver) = connection::admission();
    let (host, ready) = tokio::sync::oneshot::channel();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let worker = runtime.spawn(connection::serve(socket, receiver, ready, stopped));
    let result = render::launch_window(
        config.shell,
        config.ui,
        config.title,
        config.window_size,
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
