use serde_json::{Value, json};
use std::time::Duration;
use tokamak_worker::WORKER_FRAME_BYTES;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt},
    sync::mpsc,
};

pub(in crate::host) fn oversized(value: &Value) -> Result<bool, String> {
    Ok(serde_json::to_vec(value).map_err(|e| e.to_string())?.len() >= WORKER_FRAME_BYTES)
}

// fill_buf is cancellation-safe. Keep the partial frame across select branches.
pub(in crate::host) async fn read_frame(
    output: &mut (impl AsyncBufRead + Unpin),
    frame: &mut Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    loop {
        let bytes = output.fill_buf().await.map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("Incomplete action process message".into())
            };
        }
        let end = bytes.iter().position(|b| *b == b'\n');
        let count = end.map_or(bytes.len(), |n| n + 1);
        if frame.len() + count > WORKER_FRAME_BYTES {
            return Err("Action process message exceeds 1 MiB limit".into());
        }
        frame.extend_from_slice(&bytes[..count]);
        output.consume(count);
        if end.is_some() {
            return Ok(Some(std::mem::take(frame)));
        }
    }
}

pub(in crate::host) async fn write_messages(
    mut input: tokio::process::ChildStdin,
    mut outgoing: mpsc::Receiver<Value>,
) -> Result<(), String> {
    while let Some(message) = outgoing.recv().await {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if bytes.len() > WORKER_FRAME_BYTES {
            return Err("Action process message exceeds 1 MiB limit".into());
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            input.write_all(&bytes).await?;
            // Tokio's Windows pipe writes can finish in its blocking pool.
            #[cfg(windows)]
            input.flush().await?;
            Ok::<_, std::io::Error>(())
        })
        .await
        .map_err(|_| "Action process stdin stalled")?
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn operation_reply(
    route: Option<(u64, u64)>,
    op: u64,
    result: Result<Value, engine::CallError>,
) -> Result<Value, String> {
    let mut message = json!({"type":"opResult","id":op});
    if let Some((slot, call)) = route {
        message["slot"] = json!(slot);
        message["call"] = json!(call);
    }
    match result {
        Ok(value) => message["value"] = value,
        Err(error) => message["error"] = error.details.unwrap_or_else(|| json!(error.message)),
    }
    if oversized(&message)? {
        if let Some(object) = message.as_object_mut() {
            object.remove("value");
        }
        message["error"] = json!("Host operation result exceeds the action process's 1 MiB limit");
    }
    Ok(message)
}
