use std::{
    collections::HashMap,
    io::{self, Write},
    os::unix::net::UnixDatagram,
    path::Path,
    sync::{Arc, Mutex},
    thread,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::sync::{Notify, mpsc};

use crate::{
    modules::Bundle,
    pipe::{read_frame, shutdown},
    programs::Programs,
    runtime::Runtime,
};

const OUTPUT_BYTES: usize = 4 * WORKER_FRAME_BYTES;
// Two safe JS integer IDs, the fixed frame envelope and a newline.
const CANCEL_FRAME_BYTES: usize = 80;
const CANCELLED: &str = "Plugin action cancelled";
const DID_NOT_YIELD: &str =
    "Plugin caller action did not yield for 5 seconds; QuickJS runtime reset";

#[derive(Default)]
struct State {
    calls: HashMap<u64, bool>,
    cancellable_ops: HashMap<u64, u64>,
    queued_bytes: usize,
}

impl State {
    fn retire(&mut self, id: u64) {
        self.calls.remove(&id);
        self.cancellable_ops.retain(|_, call| *call != id);
    }

    fn fits(&self, frame: &Value, bytes: usize) -> bool {
        let reserve = usize::from(frame["type"] == "op" && frame["cancellable"] == true);
        self.queued_bytes + bytes + (self.cancellable_ops.len() + reserve) * CANCEL_FRAME_BYTES
            <= OUTPUT_BYTES
    }
}

type Shared = Arc<Mutex<State>>;

pub struct Output {
    state: Shared,
    writer: mpsc::UnboundedSender<String>,
    programs: Programs,
    drained: Arc<Notify>,
}

impl Output {
    pub fn try_send(&self, line: String) -> Result<bool> {
        ensure!(
            line.len() < WORKER_FRAME_BYTES,
            "Plugin process message exceeds 1 MiB limit"
        );
        let frame: Value = serde_json::from_str(&line)?;
        let mut state = self.state.lock().expect("protocol state");
        if frame["type"] != "opCancel" && !state.fits(&frame, line.len() + 1) {
            return Ok(false);
        }
        self.send_frame(&mut state, &frame, line)?;
        Ok(true)
    }

    pub async fn send_wait(&self, line: String) -> Result<()> {
        ensure!(
            line.len() < WORKER_FRAME_BYTES,
            "Plugin process message exceeds 1 MiB limit"
        );
        let frame: Value = serde_json::from_str(&line)?;
        loop {
            let drained = self.drained.notified();
            {
                let mut state = self.state.lock().expect("protocol state");
                if frame["type"] == "op" {
                    let call = id(&frame["call"])?;
                    ensure!(
                        state.calls.get(&call) == Some(&false),
                        "stale invocation: host operation refused"
                    );
                }
                if frame["type"] == "opCancel" || state.fits(&frame, line.len() + 1) {
                    return self.send_frame(&mut state, &frame, line);
                }
            }
            drained.await;
        }
    }

    fn send_frame(&self, state: &mut State, frame: &Value, line: String) -> Result<()> {
        match frame["type"].as_str() {
            Some("op") => {
                let call = id(&frame["call"])?;
                ensure!(
                    state.calls.get(&call) == Some(&false),
                    "stale invocation: host operation refused"
                );
                let op = id(&frame["id"])?;
                let cancellable = frame["cancellable"] == true;
                ensure!(
                    !state.cancellable_ops.contains_key(&op),
                    "Duplicate plugin process operation"
                );
                if cancellable {
                    ensure!(
                        state.cancellable_ops.len() < WORKER_CAPACITY,
                        "Plugin process cancellation capacity exceeded"
                    );
                }
                self.write(state, line)?;
                if cancellable {
                    state.cancellable_ops.insert(op, call);
                }
                return Ok(());
            }
            Some("opCancel") => {
                let call = id(&frame["call"])?;
                let op = id(&frame["id"])?;
                if state.calls.get(&call) == Some(&false)
                    && state.cancellable_ops.get(&op) == Some(&call)
                {
                    // Spend this operation's reservation once, using a bounded frame.
                    state.cancellable_ops.remove(&op);
                    self.write(
                        state,
                        json!({"type":"opCancel", "id":op, "call":call}).to_string(),
                    )?;
                    self.drained.notify_waiters();
                }
                return Ok(());
            }
            Some("result") => {
                let call = id(&frame["id"])?;
                if state.calls.get(&call) != Some(&false) {
                    return Ok(());
                }
                self.write(state, line)?;
                state.retire(call);
                self.drained.notify_waiters();
                self.programs.retire(call);
                return Ok(());
            }
            // A request can cross the last result or cancel of its owning
            // call. Let the dispatcher return a stale-channel error.
            Some("peerResult" | "log") => {}
            _ => bail!("Invalid plugin host output frame"),
        }
        self.write(state, line)
    }

    fn write(&self, state: &mut State, line: String) -> Result<()> {
        let bytes = line.len() + 1;
        self.writer
            .send(line)
            .context("Plugin process output queue closed")?;
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
        state.cancellable_ops.clear();
        self.drained.notify_waiters();
        for id in started.into_keys() {
            self.programs.retire(id);
            self.result(&mut state, id, DID_NOT_YIELD)?;
        }
        Ok(())
    }

    fn prepare(&self, frame: &Value) -> Result<bool> {
        let mut state = self.state.lock().expect("protocol state");
        let id = id(&frame["id"])?;
        match frame["type"].as_str() {
            Some("invoke") => {
                if state.calls.contains_key(&id) {
                    bail!("Duplicate plugin process invocation");
                }
                if state.calls.len() >= WORKER_CAPACITY {
                    self.result(
                        &mut state,
                        id,
                        "Plugin process invocation capacity exceeded",
                    )?;
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
            Some("peer" | "retire") => {}
            Some("opResult") => {
                if state.cancellable_ops.remove(&id).is_some() {
                    self.drained.notify_waiters();
                }
            }
            _ => bail!("Invalid plugin process message"),
        }
        Ok(true)
    }
}

fn id(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|id| *id < (1 << 53))
        .context("Invalid plugin process frame id")
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
            .context("Plugin process input queue closed")?;
    }
    Ok(())
}

fn native_control(socket: UnixDatagram, state: &Shared, programs: &Programs) -> io::Result<()> {
    let mut bytes = [0; 8];
    while socket.recv(&mut bytes)? == bytes.len() {
        let call = u64::from_le_bytes(bytes);
        {
            let state = state.lock().expect("protocol state");
            programs.kill_call(call, state.calls.contains_key(&call));
        }
        socket.send(&bytes)?;
    }
    Ok(())
}

fn write_output(
    state: Shared,
    drained: Arc<Notify>,
    mut output: mpsc::UnboundedReceiver<String>,
) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    while let Some(line) = output.blocking_recv() {
        writeln!(stdout, "{line}")?;
        stdout.flush()?;
        state.lock().expect("protocol state").queued_bytes -= line.len() + 1;
        drained.notify_waiters();
    }
    Ok(())
}

fn background(result: Result<()>) {
    if let Err(error) = result {
        eprintln!("Plugin host: {error:#}");
        std::process::exit(1);
    }
}

fn connect_pipes(
    native: Option<UnixDatagram>,
    programs: &Programs,
) -> (Arc<Output>, mpsc::Receiver<Value>) {
    let state = Shared::default();
    if let Some(socket) = native {
        let state = state.clone();
        let programs = programs.clone();
        // Independent of both the JS scheduler and the ordinary pipe reader,
        // which may be waiting for the JS input queue to have space.
        thread::spawn(move || {
            let _ = native_control(socket, &state, &programs);
        });
    }
    let (input, frames) = mpsc::channel(WORKER_CAPACITY);
    let reader_state = state.clone();
    thread::spawn(move || {
        background(read_input(&reader_state, &input));
        shutdown();
    });
    // Payload bytes include the frame currently blocked on stdout.
    let (writer, output) = mpsc::unbounded_channel();
    let writer_state = state.clone();
    let drained = Arc::new(Notify::new());
    let writer_drained = drained.clone();
    thread::spawn(move || {
        background(write_output(writer_state, writer_drained, output).map_err(Into::into))
    });

    let output = Arc::new(Output {
        state,
        writer,
        programs: programs.clone(),
        drained,
    });
    (output, frames)
}

pub async fn run(code: &Path, native: Option<UnixDatagram>) -> Result<()> {
    let heap = crate::runtime::heap_bytes()?;
    let bundles = Bundle::new(code)?;
    let programs = Programs::default();
    let (output, mut frames) = connect_pipes(native, &programs);
    let next_op = std::rc::Rc::new(std::cell::Cell::new(0_u64));
    let mut runtime = Runtime::new_local(
        bundles.clone(),
        heap,
        output.clone(),
        next_op.clone(),
        programs.clone(),
    )
    .await?;
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
                if output.prepare(&frame)? {
                    if frame["type"] == "cancel" {
                        runtime.programs.stop_call(id(&frame["id"])?);
                    }
                    let dispatched = runtime.dispatch(frame.to_string()).await;
                    if frame["type"] == "cancel" {
                        let id = id(&frame["id"])?;
                        let mut state = output.state.lock().expect("protocol state");
                        state.retire(id);
                        output.drained.notify_waiters();
                        programs.retire(id);
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
            runtime = Runtime::new_local(
                bundles.clone(),
                heap,
                output.clone(),
                next_op.clone(),
                programs.clone(),
            )
            .await?;
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
    fn only_pending_operations_can_use_reserved_cancel_space() {
        let state = Shared::default();
        let (writer, mut frames) = mpsc::unbounded_channel();
        let output = Output {
            state,
            writer,
            programs: Programs::default(),
            drained: Arc::new(Notify::new()),
        };
        {
            let mut state = output.state.lock().unwrap();
            state.calls.extend([(1, false), (2, false)]);
            state.queued_bytes = OUTPUT_BYTES - 160;
        }

        let send = |frame: Value| output.try_send(frame.to_string());
        send(json!({"type":"op","call":1,"id":3,"cancellable":true})).unwrap();
        assert!(!send(json!({"type":"log","text":"no space left here"})).unwrap());
        send(json!({"type":"opCancel","call":2,"id":3})).unwrap();
        send(json!({"type":"opCancel","call":1,"id":4})).unwrap();
        send(json!({"type":"opCancel","call":1,"id":3,"extra":"x".repeat(2048)})).unwrap();
        send(json!({"type":"opCancel","call":1,"id":3})).unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&frames.try_recv().unwrap()).unwrap()["type"],
            "op"
        );
        let cancel = frames.try_recv().unwrap();
        assert!(cancel.len() < CANCEL_FRAME_BYTES);
        assert_eq!(
            serde_json::from_str::<Value>(&cancel).unwrap(),
            json!({"type":"opCancel","id":3,"call":1})
        );
        assert!(frames.try_recv().is_err());
        assert!(output.state.lock().unwrap().queued_bytes <= OUTPUT_BYTES);
    }

    #[test]
    fn output_queue_counts_bytes_until_the_writer_flushes() {
        let state = Shared::default();
        let (writer, _output) = mpsc::unbounded_channel();
        let output = Output {
            state,
            writer,
            programs: Programs::default(),
            drained: Arc::new(Notify::new()),
        };
        let frame =
            json!({ "type": "log", "level": "info", "text": "x".repeat(WORKER_FRAME_BYTES - 50) })
                .to_string();
        for _ in 0..4 {
            assert!(output.try_send(frame.clone()).unwrap());
        }
        assert!(!output.try_send(frame).unwrap());
    }

    #[tokio::test]
    async fn peer_reply_waits_for_output_space() {
        let state = Shared::default();
        let (writer, mut receive) = mpsc::unbounded_channel();
        let output = Output {
            state: state.clone(),
            writer,
            programs: Programs::default(),
            drained: Arc::new(Notify::new()),
        };
        let line = json!({"type":"peerResult", "id":1, "call":2, "value":"approve"}).to_string();
        {
            let mut state = state.lock().unwrap();
            state.calls.insert(2, false);
            state.queued_bytes = OUTPUT_BYTES;
        }
        let send = output.send_wait(line.clone());
        tokio::pin!(send);
        tokio::select! {
            result = &mut send => panic!("reply must wait for the writer: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
        assert!(receive.try_recv().is_err());
        state.lock().unwrap().queued_bytes = 0;
        output.drained.notify_waiters();
        send.await.unwrap();
        assert_eq!(receive.try_recv().unwrap(), line);
    }
}
