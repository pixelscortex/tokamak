use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    path::Path,
    sync::{Arc, Mutex},
    thread,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::sync::mpsc;

use crate::{modules::Bundles, runtime::Runtime};

const OUTPUT_BYTES: usize = 4 * WORKER_FRAME_BYTES;
const CANCELLED: &str = "Plugin local function cancelled";
const DID_NOT_YIELD: &str =
    "Plugin local function did not yield for 5 seconds; QuickJS runtime reset";

#[derive(Default)]
struct State {
    calls: HashMap<u64, bool>,
    contract_ops: HashMap<u64, u64>,
    queued_bytes: usize,
}

impl State {
    fn retire(&mut self, id: u64) {
        self.calls.remove(&id);
        self.contract_ops.retain(|_, call| *call != id);
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
                    state.calls.get(&call) == Some(&false),
                    "stale invocation: host operation refused"
                );
                if frame["name"] == "local.contracts" {
                    let op = id(&frame["id"])?;
                    self.enqueue(&mut state, line)?;
                    state.contract_ops.insert(op, call);
                    return Ok(());
                }
            }
            Some("result") => {
                let call = id(&frame["id"])?;
                if state.calls.get(&call) != Some(&false) {
                    return Ok(());
                }
                self.enqueue(&mut state, line)?;
                state.retire(call);
                return Ok(());
            }
            Some("log") => {}
            _ => bail!("Invalid plugin host output frame"),
        }
        self.enqueue(&mut state, line)
    }

    fn enqueue(&self, state: &mut State, line: String) -> Result<()> {
        ensure!(
            state.queued_bytes + line.len() < OUTPUT_BYTES,
            "Worker output queue exceeds 4 MiB limit"
        );
        self.write(state, line)
    }

    fn write(&self, state: &mut State, line: String) -> Result<()> {
        let bytes = line.len() + 1;
        self.writer
            .send(line)
            .context("Worker output queue closed")?;
        state.queued_bytes += bytes;
        Ok(())
    }

    /// The host's own answers skip the queue limit: a plugin that filled the
    /// queue must not stop the host from refusing or ending a call. Input
    /// back-pressure already bounds how many of these can be waiting.
    fn result(&self, state: &mut State, id: u64, error: &str) -> Result<()> {
        self.write(
            state,
            json!({ "type": "result", "id": id, "error": error }).to_string(),
        )
    }

    fn stop_calls(&self) -> Result<()> {
        let mut state = self.state.lock().expect("protocol state");
        let started = std::mem::take(&mut state.calls);
        state.contract_ops.clear();
        for id in started.into_keys() {
            self.result(&mut state, id, DID_NOT_YIELD)?;
        }
        Ok(())
    }

    fn prepare(&self, frame: &Value, bundles: &Bundles) -> Result<bool> {
        let mut state = self.state.lock().expect("protocol state");
        let id = id(&frame["id"])?;
        match frame["type"].as_str() {
            Some("invoke") => {
                if state.calls.contains_key(&id) {
                    bail!("Duplicate worker invocation");
                }
                if state.calls.len() >= WORKER_CAPACITY {
                    self.result(&mut state, id, "Worker invocation capacity exceeded")?;
                    return Ok(false);
                }
                state.calls.insert(id, false);
            }
            Some("cancel") => {
                let Some(cancelled) = state.calls.get_mut(&id) else {
                    return Ok(false);
                };
                *cancelled = true;
                self.result(&mut state, id, CANCELLED)?;
            }
            Some("opResult") => {
                if let Some(call) = state.contract_ops.remove(&id)
                    && state.calls.get(&call) == Some(&false)
                    && frame["error"].is_null()
                    && let Some(candidates) = frame["value"].as_array()
                {
                    bundles.allow_candidates(candidates);
                }
            }
            _ => bail!("Invalid worker message"),
        }
        Ok(true)
    }
}

fn id(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|id| *id < (1 << 53))
        .context("Invalid worker frame id")
}

pub(crate) fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>> {
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
        if frame["type"] == "shutdown" {
            break;
        }
        if frame["type"] == "cancel"
            && let Some(call) = state
                .lock()
                .expect("protocol state")
                .calls
                .get_mut(&id(&frame["id"])?)
        {
            // Refuse new output for this call even if JS is still unwinding a job.
            *call = true;
        }
        send.blocking_send(frame)
            .context("Worker input queue closed")?;
    }
    Ok(())
}

pub(crate) fn shutdown() -> ! {
    // The launcher makes the host the process group leader.
    unsafe {
        libc::kill(-libc::getpid(), libc::SIGKILL);
    }
    std::process::exit(0);
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
    let heap = crate::runtime::heap_bytes()?;
    let bundles = Bundles::new(code)?;
    let state = Shared::default();
    let (input, mut frames) = mpsc::channel(WORKER_CAPACITY);
    let reader_state = state.clone();
    thread::spawn(move || {
        background(read_input(&reader_state, &input));
        shutdown();
    });
    // Payload bytes include the frame currently blocked on stdout.
    let (writer, output) = mpsc::unbounded_channel();
    let writer_state = state.clone();
    thread::spawn(move || background(write_output(writer_state, output).map_err(Into::into)));

    let output = Arc::new(Output { state, writer });
    let next_op = std::rc::Rc::new(std::cell::Cell::new(0_u64));
    let mut runtime = Runtime::new(bundles.clone(), heap, output.clone(), next_op.clone()).await?;
    let mut frames_since_immediate = 0;
    loop {
        // Give arrived input and promise jobs priority over immediates,
        // but a producer refilling the queue cannot starve the scheduler step.
        if !runtime.immediates.pending() {
            frames_since_immediate = 0;
        }
        let take_frame = frames_since_immediate < WORKER_CAPACITY;
        // Poll JS before taking another input frame so a busy pipe cannot starve it.
        let dispatch = tokio::select! {
            biased;
            () = runtime.drive() => Ok(()),
            frame = frames.recv(), if take_frame => {
                frames_since_immediate += 1;
                let Some(frame) = frame else { return Ok(()) };
                if output.prepare(&frame, &bundles)? {
                    if frame["type"] == "cancel" {
                        runtime.programs.stop_call(id(&frame["id"])?);
                    }
                    let dispatched = runtime.dispatch(frame.to_string()).await;
                    if frame["type"] == "cancel" {
                        output.state.lock().expect("protocol state").retire(id(&frame["id"])?);
                    }
                    dispatched
                } else {
                    Ok(())
                }
            }
            () = runtime.immediates.ready() => {
                runtime.immediates.fire();
                frames_since_immediate = 0;
                Ok(())
            }
        };

        if runtime.interrupted() {
            drop(runtime);
            output.stop_calls()?;
            runtime = Runtime::new(bundles.clone(), heap, output.clone(), next_op.clone()).await?;
        } else {
            dispatch?;
        }

        // Let Tokio wake due timers and I/O before processing more buffered frames.
        tokio::task::yield_now().await;
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
