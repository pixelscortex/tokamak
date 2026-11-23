use std::{path::Path, time::Duration};

use serde_json::Value;
use tokio::io::BufReader;

use crate::host::worker::process::read_frame;

pub(crate) async fn inspect_legacy(code: &Path) -> Result<bool, String> {
    inspect(code, None, "older plugin bundle").await?["hasActions"]
        .as_bool()
        .ok_or_else(|| "Invalid plugin host inspection response".into())
}

pub(super) async fn inspect_action(code: &Path, worker_entry: bool) -> Result<(), String> {
    let heap = tokamak_worker::configured_action_heap_bytes()?;
    let message = inspect(code, Some((heap, worker_entry)), "plugin action bundle").await?;
    if message["ok"] != true {
        return Err("Invalid plugin host inspection response".into());
    }
    Ok(())
}

async fn inspect(
    code: &Path,
    action: Option<(usize, bool)>,
    subject: &str,
) -> Result<Value, String> {
    let host = tokamak_worker::Process::action_host_path()?;
    let mut child = tokamak_worker::Process::inspect_actions(&host, code, action)?;
    let (_stdin, stdout, _stderr) = child.pipes()?;
    let mut output = BufReader::new(stdout);
    let mut buffer = Vec::new();
    let frame = tokio::time::timeout(
        Duration::from_secs(10),
        read_frame(&mut output, &mut buffer),
    )
    .await;
    child.stop().await;

    let frame = frame
        .map_err(|_| format!("Inspecting {subject} timed out"))??
        .ok_or_else(|| format!("Plugin host exited while inspecting {subject}"))?;
    let message: Value = serde_json::from_slice(&frame).map_err(|error| error.to_string())?;
    if let Some(error) = message["error"].as_str() {
        return Err(format!("Inspect {subject}: {error}"));
    }
    Ok(message)
}
