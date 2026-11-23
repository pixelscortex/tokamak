use std::io;

use tokamak_worker::WORKER_FRAME_BYTES;
use tokio::io::{AsyncRead, AsyncReadExt};

pub struct Lines<R> {
    source: Option<R>,
    buffer: Box<[u8]>,
    tail: Vec<u8>,
    too_long: bool,
}

impl<R: AsyncRead + Unpin> Lines<R> {
    pub fn new(source: R) -> Self {
        Self {
            source: Some(source),
            buffer: vec![0; 64 * 1024].into_boxed_slice(),
            tail: Vec::new(),
            too_long: false,
        }
    }

    pub async fn read(&mut self) -> io::Result<Vec<String>> {
        if std::mem::take(&mut self.too_long) {
            return Err(io::Error::other("Program output line exceeds 1 MiB"));
        }
        while let Some(source) = &mut self.source {
            // No background read: once the plugin stops taking batches, the
            // pipe fills and the executable blocks instead of growing a queue.
            let size = source.read(&mut self.buffer).await?;
            if size == 0 {
                self.source = None;
                let tail = std::mem::take(&mut self.tail);
                return Ok(if tail.is_empty() {
                    Vec::new()
                } else {
                    vec![decode(&tail)]
                });
            }

            let lines = self.take_lines(size);
            if !lines.is_empty() {
                return Ok(lines);
            }
            if std::mem::take(&mut self.too_long) {
                return Err(io::Error::other("Program output line exceeds 1 MiB"));
            }
        }
        Ok(Vec::new())
    }

    fn take_lines(&mut self, size: usize) -> Vec<String> {
        let mut lines = Vec::new();
        for part in self.buffer[..size].split_inclusive(|byte| *byte == b'\n') {
            let complete = part.ends_with(b"\n");
            let part = if complete {
                &part[..part.len() - 1]
            } else {
                part
            };
            if self.tail.len() + part.len() > WORKER_FRAME_BYTES {
                self.source = None;
                self.tail.clear();
                self.too_long = true;
                break;
            }

            self.tail.extend_from_slice(part);
            if complete {
                lines.push(decode(&self.tail));
                self.tail.clear();
            }
        }
        lines
    }
}

fn decode(line: &[u8]) -> String {
    String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line)).into_owned()
}
