use std::{path::Path, time::Duration};

use serde_json::Value;
use tokio::io::BufReader;

use crate::host::worker::process::read_frame;

pub(crate) async fn inspect_legacy(code: &Path) -> Result<bool, String> {
    let host = tokamak_worker::Process::action_host_path()?;
    let mut child = tokamak_worker::Process::inspect_actions(&host, code)?;
    let (_stdin, stdout, _stderr) = child.pipes()?;
    let mut output = BufReader::new(stdout);
    let mut buffer = Vec::new();
    let frame =
        tokio::time::timeout(Duration::from_secs(5), read_frame(&mut output, &mut buffer)).await;
    child.stop().await;

    let frame = frame
        .map_err(|_| "Inspecting older plugin bundle timed out")??
        .ok_or("Plugin host exited while inspecting older bundle")?;
    let message: Value = serde_json::from_slice(&frame).map_err(|error| error.to_string())?;
    if let Some(error) = message["error"].as_str() {
        return Err(format!("Inspect older plugin bundle: {error}"));
    }
    message["hasActions"]
        .as_bool()
        .ok_or_else(|| "Invalid plugin host inspection response".into())
}
