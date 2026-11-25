use std::io::BufRead;

use anyhow::{Result, ensure};
use serde_json::Value;
use tokamak_worker::WORKER_FRAME_BYTES;

pub(crate) fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            ensure!(line.is_empty(), "Truncated process frame");
            return Ok(None);
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let count = end.unwrap_or(buffer.len());
        ensure!(
            line.len() + count < WORKER_FRAME_BYTES,
            "Process message exceeds 1 MiB limit"
        );
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count + usize::from(end.is_some()));
        if end.is_some() {
            return Ok(Some(serde_json::from_slice(&line)?));
        }
    }
}

pub(crate) fn shutdown() -> ! {
    // The launcher makes the host the process group leader.
    unsafe {
        libc::kill(-libc::getpid(), libc::SIGKILL);
    }
    std::process::exit(0);
}
