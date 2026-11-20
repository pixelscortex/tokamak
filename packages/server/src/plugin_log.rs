//! Plugin logs bypass the best-effort server stderr queue.
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const WINDOW_TEXT_BYTES: usize = 8192;
static FILES: Mutex<()> = Mutex::new(());

fn path(id: &str) -> io::Result<PathBuf> {
    crate::data::DataSpace::plugin(id).map_err(io::Error::other)?;
    let folder = std::env::var_os("TOKAMAK_PLUGIN_LOG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("tokamak").join("logs"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&folder)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(&folder)?;
    Ok(folder.join(format!("{id}.log")))
}

fn file(id: &str, truncate: bool) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path(id)?)
}

pub(crate) fn clear(id: &str) -> io::Result<()> {
    let _guard = FILES
        .lock()
        .map_err(|_| io::Error::other("plugin log lock poisoned"))?;
    file(id, true)?;
    Ok(())
}

fn append(id: &str, source: &str, level: &str, text: &str) -> io::Result<()> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut line = serde_json::to_vec(&serde_json::json!({
        "time": time, "source": source, "level": level, "text": text,
    }))?;
    line.push(b'\n');
    let _guard = FILES
        .lock()
        .map_err(|_| io::Error::other("plugin log lock poisoned"))?;
    file(id, false)?.write_all(&line)
}

pub(crate) fn window(id: &str, text: &str) -> io::Result<()> {
    append(id, "window", "error", text)?;
    crate::host::worker::server_line(format!("Plugin {id} [error]: {text}"));
    Ok(())
}

pub(crate) fn server(id: &str, level: &str, text: &str) -> Result<(), String> {
    crate::host::worker::server_line(format!("Plugin {id} [{level}]: {text}"));
    append(id, "server", level, text)
        .map_err(|error| format!("Could not write plugin log: {error}"))
}

pub(crate) fn function_error(id: &str, name: &str, error: &str) {
    if let Err(error) = server(id, "error", &format!("{name}: {error}")) {
        crate::host::worker::server_line(error);
    }
}

pub(crate) fn console(ops: &mut engine::OpRegistry, id: String) {
    ops.set_console(move |level, text| server(&id, level, text));
}

pub(crate) fn action_result<T>(
    owner: Option<&str>,
    name: &str,
    result: Result<T, String>,
) -> Result<T, String> {
    if let (Some(owner), Err(error)) = (owner, &result) {
        function_error(owner, name, error);
    }
    result
}
