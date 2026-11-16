//! Native UI host and bounded client drain; never owns server/storage lifetime.
pub mod connection;
mod private_file;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub struct ClientConfig<'a> {
    pub title: &'a str,
    pub shell: &'a str,
    pub ui: &'a str,
    pub window_size: (u32, u32),
    /// `minWidth` / `minHeight` from app.config.json, if set.
    pub min_window_size: Option<(u32, u32)>,
}

impl ClientConfig<'_> {
    /// Window options from the config: the platform title bar, and the
    /// minimum size if the config sets one.
    pub fn window_options(&self) -> render::WindowOptions {
        render::WindowOptions {
            min_size: self.min_window_size,
            ..Default::default()
        }
    }
}

/// UI-only clients do not discover or connect to a backend.
pub fn run_ui(config: ClientConfig<'_>) -> Result<(), Error> {
    render::launch_window_with(
        config.shell,
        config.ui,
        config.title,
        config.window_size,
        config.window_options(),
        None,
        |_| {},
    )?;
    Ok(())
}

pub fn run(config: ClientConfig<'_>) -> Result<(), Error> {
    let options = config.window_options();
    run_with(config, options)
}

/// As `run`, for a product that sets its own window options (for example a
/// page-drawn title bar). Start from `config.window_options()` to keep the
/// configured minimum size.
pub fn run_with(config: ClientConfig<'_>, options: render::WindowOptions) -> Result<(), Error> {
    let directory = data_directory()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let socket = runtime.block_on(connection::connect(&directory))?;
    let (requests, receiver) = connection::admission();
    let (host, ready) = tokio::sync::oneshot::channel();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let worker = runtime.spawn(connection::serve(socket, receiver, ready, stopped));
    let result = render::launch_window_with(
        config.shell,
        config.ui,
        config.title,
        config.window_size,
        options,
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

/// Directory for local server connection discovery.
pub fn data_directory() -> Result<std::path::PathBuf, Error> {
    std::env::var_os("TOKAMAK_SERVER_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            directories::ProjectDirs::from("com", "pixelscortex", "Tokamak")
                .map(|p| p.data_local_dir().to_owned())
        })
        .ok_or_else(|| "Cannot locate application data directory".into())
}
