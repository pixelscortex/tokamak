use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::sync::mpsc;

use crate::runtime::Runtime;

const OUTPUT_BYTES: usize = 4 * WORKER_FRAME_BYTES;
pub const DEADLINE: Duration = Duration::from_secs(5);

struct Call {
    deadline: Option<Instant>,
    cancelled: bool,
}

#[derive(Default)]
pub struct State {
    calls: HashMap<u64, Call>,
    queued_bytes: usize,
    stopped: bool,
}

impl State {
    pub fn interrupt(&self) -> bool {
        self.stopped
            || self.calls.values().any(|call| {
                call.deadline
                    .is_some_and(|end| call.cancelled || end <= Instant::now())
            })
    }

    fn deadline(&self) -> Option<Instant> {
        self.calls.values().filter_map(|call| call.deadline).min()
    }
}

type Shared = Arc<Mutex<State>>;

pub struct Output {
    state: Shared,
    writer: mpsc::UnboundedSender<String>,
}

impl Output {
    pub fn send(&self, line: String) -> Result<()> {
        ensure!(
            line.len() < WORKER_FRAME_BYTES,
            "Worker message exceeds 1 MiB limit"
        );
        let frame: Value = serde_json::from_str(&line)?;
        let mut state = self.state.lock().expect("protocol state");
        match frame["type"].as_str() {
            Some("op") => {
                let call = id(&frame["call"])?;
                ensure!(
                    state.calls.get(&call).is_some_and(|call| !call.cancelled
                        && call.deadline.is_some_and(|end| end > Instant::now())),
                    "stale invocation: host operation refused"
                );
            }
            Some("result") => {
                let call = id(&frame["id"])?;
                if state.calls.get(&call).is_none_or(|call| {
                    call.cancelled || call.deadline.is_none_or(|end| end <= Instant::now())
                }) {
                    return Ok(());
                }
                self.enqueue(&mut state, line)?;
                state.calls.remove(&call);
                return Ok(());
            }
            Some("log") => {}
            _ => bail!("Invalid plugin host output frame"),
        }
        self.enqueue(&mut state, line)
    }

    fn enqueue(&self, state: &mut State, line: String) -> Result<()> {
        let bytes = line.len() + 1;
        ensure!(
            state.queued_bytes + bytes <= OUTPUT_BYTES,
            "Worker output queue exceeds 4 MiB limit"
        );
        self.writer
            .send(line)
            .context("Worker output queue closed")?;
        state.queued_bytes += bytes;
        Ok(())
    }

    fn stop_calls(&self) -> Result<()> {
        let mut state = self.state.lock().expect("protocol state");
        let now = Instant::now();
        let started: Vec<_> = state
            .calls
            .iter()
            .filter_map(|(id, call)| call.deadline.map(|_| *id))
            .collect();
        for id in started {
            let Some(call) = state.calls.remove(&id) else {
                continue;
            };
            let error = if call.cancelled {
                "Plugin local function cancelled"
            } else if call.deadline.is_some_and(|end| end <= now) {
                "Plugin local function deadline exceeded"
            } else {
                "Plugin local function stopped when its QuickJS runtime was reset"
            };
            self.enqueue(
                &mut state,
                json!({ "type": "result", "id": id, "error": error }).to_string(),
            )?;
        }
        Ok(())
    }
}

fn id(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|id| *id < (1 << 53))
        .context("Invalid worker frame id")
}

fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            ensure!(line.is_empty(), "Truncated worker frame");
            return Ok(None);
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let count = end.unwrap_or(buffer.len());
        ensure!(
            line.len() + count < WORKER_FRAME_BYTES,
            "Worker message exceeds 1 MiB limit"
        );
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count + usize::from(end.is_some()));
        if end.is_some() {
            return Ok(Some(serde_json::from_slice(&line)?));
        }
    }
}

fn read_input(state: &Shared, send: &mpsc::Sender<Value>) -> Result<()> {
    let mut reader = io::stdin().lock();
    while let Some(frame) = read_frame(&mut reader)? {
        match frame["type"].as_str() {
            Some("shutdown") => break,
            Some("invoke") => {
                let id = id(&frame["id"])?;
                {
                    let mut state = state.lock().expect("protocol state");
                    ensure!(
                        !state.calls.contains_key(&id),
                        "Duplicate worker invocation"
                    );
                    ensure!(
                        state.calls.len() < WORKER_CAPACITY,
                        "Worker invocation capacity exceeded"
                    );
                    state.calls.insert(
                        id,
                        Call {
                            deadline: None,
                            cancelled: false,
                        },
                    );
                }
                send.try_send(frame)
                    .context("Worker input queue full or closed")?;
            }
            Some("opResult") => {
                id(&frame["id"])?;
                send.try_send(frame)
                    .context("Worker input queue full or closed")?;
            }
            Some("cancel") => {
                let id = id(&frame["id"])?;
                if let Some(call) = state.lock().expect("protocol state").calls.get_mut(&id) {
                    call.cancelled = true;
                }
                send.try_send(frame)
                    .context("Worker input queue full or closed")?;
            }
            _ => bail!("Invalid worker message"),
        }
    }
    Ok(())
}

fn write_output(state: Shared, mut output: mpsc::UnboundedReceiver<String>) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    while let Some(line) = output.blocking_recv() {
        writeln!(stdout, "{line}")?;
        stdout.flush()?;
        state.lock().expect("protocol state").queued_bytes -= line.len() + 1;
    }
    Ok(())
}

fn background(result: Result<()>) {
    if let Err(error) = result {
        eprintln!("Plugin host: {error:#}");
        std::process::exit(1);
    }
}

pub async fn run(code: &Path) -> Result<()> {
    let state = Shared::default();
    let (input, mut frames) = mpsc::channel(WORKER_CAPACITY);
    let reader_state = state.clone();
    thread::spawn(move || {
        background(read_input(&reader_state, &input));
        reader_state.lock().expect("protocol state").stopped = true;
    });
    // Payload bytes include the frame currently blocked on stdout.
    let (writer, output) = mpsc::unbounded_channel();
    let writer_state = state.clone();
    thread::spawn(move || background(write_output(writer_state, output).map_err(Into::into)));

    let output = Arc::new(Output {
        state: state.clone(),
        writer,
    });
    let next_op = std::rc::Rc::new(std::cell::Cell::new(0_u64));
    let mut runtime = Runtime::new(code, state.clone(), output.clone(), next_op.clone()).await?;
    loop {
        if state.lock().expect("protocol state").stopped {
            return Ok(());
        }
        if state.lock().expect("protocol state").interrupt() {
            output.stop_calls()?;
            drop(runtime);
            runtime = Runtime::new(code, state.clone(), output.clone(), next_op.clone()).await?;
        }
        let deadline = state.lock().expect("protocol state").deadline();
        let received = tokio::select! {
            biased;
            frame = frames.recv() => frame,
            () = until(deadline) => continue,
            () = runtime.drive() => bail!("QuickJS runtime closed"),
        };
        let Some(frame) = received else {
            return Ok(());
        };
        match frame["type"].as_str() {
            Some("invoke") => {
                let id = id(&frame["id"])?;
                let mut state = state.lock().expect("protocol state");
                let call = state
                    .calls
                    .get_mut(&id)
                    .context("Missing admitted invocation")?;
                if call.cancelled {
                    state.calls.remove(&id);
                    output.enqueue(&mut state, json!({ "type": "result", "id": id, "error": "Plugin local function cancelled" }).to_string())?;
                    continue;
                }
                call.deadline = Some(Instant::now() + DEADLINE);
            }
            Some("cancel") if !state.lock().expect("protocol state").interrupt() => continue,
            _ => {}
        }

        let dispatch = if state.lock().expect("protocol state").interrupt() {
            Ok(())
        } else {
            runtime.dispatch(frame.to_string()).await
        };
        if !state.lock().expect("protocol state").interrupt() {
            dispatch?;
        }
    }
}

async fn until(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline.into()).await;
    } else {
        std::future::pending::<()>().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_queue_counts_bytes_until_the_writer_flushes() {
        let state = Shared::default();
        let (writer, _output) = mpsc::unbounded_channel();
        let output = Output { state, writer };
        let frame =
            json!({ "type": "log", "level": "info", "text": "x".repeat(WORKER_FRAME_BYTES - 50) })
                .to_string();
        for _ in 0..4 {
            output.send(frame.clone()).unwrap();
        }
        assert_eq!(
            output.send(frame).unwrap_err().to_string(),
            "Worker output queue exceeds 4 MiB limit"
        );
    }
}
