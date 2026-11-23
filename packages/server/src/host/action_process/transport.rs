use std::collections::HashMap;

use tokio::{
    io::{AsyncReadExt, BufReader},
    task::JoinSet,
};
use tokio_util::task::AbortOnDropHandle;

use super::*;
use crate::host::worker::process::{operation_reply, read_frame, write_messages};

type OpResult = (u64, u64, Result<Value, String>, OwnedSemaphorePermit);

pub(super) fn start(runtime: &Handle, host: &Path, timing: Timing) -> Result<Arc<Running>, String> {
    let _entered = runtime.enter();
    let mut child = tokamak_worker::Process::launch_actions(host)
        .map_err(|error| format!("Action process could not start: {error}"))?;
    let (input, output, stderr) = child.pipes()?;
    let (commands, receive) = mpsc::unbounded_channel();
    let process = Arc::new(Running {
        commands,
        stop: CancellationToken::new(),
        ended: CancellationToken::new(),
        stopped_at: OnceLock::new(),
        #[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
        pid: child.id().ok_or("Action process has no PID")?,
        started: Instant::now(),
    });

    let running = process.clone();
    let finished = process.ended.clone().drop_guard();
    runtime.spawn(async move {
        let _finished = finished;
        let _stderr = AbortOnDropHandle::new(tokio::spawn(drain_stderr(stderr)));
        let (outgoing, writes) = mpsc::channel(WORKER_CAPACITY * 2);
        let mut calls = HashMap::new();
        let (pong, answers) = tokio::sync::watch::channel((0, running.started));
        let error = tokio::select! {
            biased;
            () = running.stop.cancelled() => "Action process stopped".into(),
            error = child.exited() => format!("Action process exited: {error}"),
            result = write_messages(input, writes) =>
                format!("Action process exited: {}", result.err().unwrap_or_else(|| "stdin closed".into())),
            result = exchange(&outgoing, BufReader::new(output), receive, &mut calls, pong) =>
                format!("Action process exited: {}", result.err().unwrap_or_else(|| "stdout closed".into())),
            error = heartbeat(&outgoing, answers, timing) => error,
        };
        let _ = running.stopped_at.set(Instant::now());
        running.stop.cancel();

        for (_, call) in calls {
            call.active.cancel();
            let _ = call.reply.send(Err(error.clone()));
        }
        child.stop().await;
    });
    Ok(process)
}

async fn exchange(
    outgoing: &mpsc::Sender<Value>,
    mut output: BufReader<tokio::process::ChildStdout>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    calls: &mut HashMap<u64, Box<Call>>,
    pong: tokio::sync::watch::Sender<(u64, Instant)>,
) -> Result<(), String> {
    let mut broker = Broker {
        outgoing,
        calls,
        ops: JoinSet::new(),
        plugins: HashMap::new(),
    };
    let mut buffer = Vec::new();
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(command) => broker.command(command).await?,
                None => return Ok(()),
            },
            Some(result) = broker.ops.join_next() => {
                if let Ok(result) = result {
                    broker.forward_op_result(result).await?;
                }
            }
            frame = read_frame(&mut output, &mut buffer) => {
                let Some(frame) = frame? else { return Ok(()) };
                let message: Value = serde_json::from_slice(&frame).map_err(|e| e.to_string())?;
                if message["type"] == "pong" {
                    let id = number(&message, "id")?;
                    pong.send_if_modified(|answer| {
                        if id <= answer.0 {
                            return false;
                        }
                        *answer = (id, Instant::now());
                        true
                    });
                } else {
                    broker.message(message).await?;
                }
            }
        }
    }
}

async fn heartbeat(
    outgoing: &mpsc::Sender<Value>,
    mut answers: tokio::sync::watch::Receiver<(u64, Instant)>,
    timing: Timing,
) -> String {
    let mut ticks = tokio::time::interval_at(Instant::now() + timing.ping, timing.ping);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut id = 0;
    let mut probe = None;
    loop {
        let (acknowledged, last) = *answers.borrow_and_update();
        if probe.is_some_and(|(previous, _)| previous != acknowledged) {
            probe = None;
        }
        let deadline = probe.map_or(last + timing.unresponsive, |(_, deadline)| deadline);
        tokio::select! {
            biased;
            answer = answers.changed() => {
                if answer.is_err() {
                    return "Action process exited: heartbeat channel closed".into();
                }
            }
            () = tokio::time::sleep_until(deadline) => {
                if probe.is_some() {
                    return "Action process is unresponsive: heartbeat timed out".into();
                }
                // The server may have been paused with a pong still in the pipe.
                // Give the reader another interval and send a fresh probe.
                id += 1;
                let _ = outgoing.try_send(json!({"type":"ping","id":id}));
                probe = Some((acknowledged, Instant::now() + timing.ping));
            }
            _ = ticks.tick() => {
                id += 1;
                // A stopped child may have filled its pipe. Keep the deadline
                // running even if a ping cannot currently be queued.
                let _ = outgoing.try_send(json!({"type":"ping","id":id}));
            }
        }
    }
}

struct Broker<'a> {
    outgoing: &'a mpsc::Sender<Value>,
    calls: &'a mut HashMap<u64, Box<Call>>,
    ops: JoinSet<OpResult>,
    plugins: HashMap<u64, String>,
}

impl Broker<'_> {
    async fn command(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Invoke(mut call) => {
                if !is_active(&call) {
                    let _ = call.reply.send(Err("Plugin action cancelled".into()));
                    return Ok(());
                }
                self.plugins
                    .entry(call.source.slot)
                    .or_insert_with(|| call.source.name.clone());
                let frame = std::mem::take(&mut call.frame);
                self.calls.insert(call.id, call);
                send(self.outgoing, frame).await
            }
            Command::Cancel(id) => {
                if let Some(call) = self.calls.remove(&id) {
                    call.active.cancel();
                    send(
                        self.outgoing,
                        json!({"type":"cancel","slot":call.source.slot,"id":id}),
                    )
                    .await?;
                }
                Ok(())
            }
            Command::Retire(slot) => {
                self.calls.retain(|_, call| call.source.slot != slot);
                if self.plugins.remove(&slot).is_some() {
                    send(self.outgoing, json!({"type":"drop","slot":slot})).await?;
                }
                Ok(())
            }
        }
    }

    async fn message(&mut self, message: Value) -> Result<(), String> {
        let slot = number(&message, "slot")?;
        match message["type"].as_str() {
            Some("result") => self.result(slot, message),
            Some("op") => self.operation(slot, message).await,
            Some("log") => {
                if let Some(plugin) = self.plugins.get(&slot) {
                    tokamak_worker::log(format!(
                        "Plugin {plugin} [{}]: {}",
                        message["level"].as_str().unwrap_or("info"),
                        message["text"].as_str().unwrap_or("")
                    ));
                }
                Ok(())
            }
            _ => Err("Invalid action process message".into()),
        }
    }

    fn result(&mut self, slot: u64, message: Value) -> Result<(), String> {
        let id = number(&message, "id")?;
        if let std::collections::hash_map::Entry::Occupied(entry) = self.calls.entry(id)
            && entry.get().source.slot == slot
        {
            let call = entry.remove();
            call.active.cancel();
            let result = if let Some(error) = message["error"].as_str() {
                let mut error = error.to_owned();
                if let Some(stack) = message["stack"].as_str().filter(|stack| !stack.is_empty()) {
                    error.push('\n');
                    error.push_str(&call.source.bundle.remap_stack(stack, "tokamak-action.js"));
                }
                Err(error)
            } else {
                Ok(message.get("value").cloned().unwrap_or(Value::Null))
            };
            let _ = call.reply.send(result);
        }
        Ok(())
    }

    async fn operation(&mut self, slot: u64, message: Value) -> Result<(), String> {
        let id = number(&message, "call")?;
        let op = number(&message, "id")?;
        let authorized = self.calls.get(&id).filter(|call| {
            call.source.slot == slot && is_active(call) && message.get("plugin").is_none()
        });
        let Some(call) = authorized else {
            return send(
                self.outgoing,
                op_error(slot, id, op, "stale invocation: host operation refused"),
            )
            .await;
        };
        // A sign-in action also needs host operations to check credentials.
        let operations = if call.anonymous_permit.is_some() {
            &call.source.anonymous_operations
        } else {
            &call.source.operations
        };
        let Ok(permit) = operations.clone().try_acquire_owned() else {
            return send(
                self.outgoing,
                op_error(
                    slot,
                    id,
                    op,
                    &format!(
                        "Plugin {} reached its host operation limit ({PLUGIN_CAPACITY})",
                        call.source.name
                    ),
                ),
            )
            .await;
        };
        if self.ops.len() >= WORKER_CAPACITY {
            return send(
                self.outgoing,
                op_error(slot, id, op, "Action process operation capacity exceeded"),
            )
            .await;
        }
        let name = message["name"]
            .as_str()
            .ok_or("Invalid action operation name")?
            .to_owned();
        let payload = message
            .get("payload")
            .ok_or("Action operation has no payload")?
            .clone();
        let registry = call.ops.clone();
        let active = call.active.clone();
        let retired = call.source.retired.clone();
        self.ops.spawn(async move {
            let result = tokio::select! {
                biased;
                () = active.cancelled() => Err("stale invocation".into()),
                () = retired.cancelled() => Err("stale invocation".into()),
                result = registry.dispatch(&name, payload) => result,
            };
            (id, op, result, permit)
        });
        Ok(())
    }

    async fn forward_op_result(&self, (id, op, result, _permit): OpResult) -> Result<(), String> {
        if let Some(call) = self.calls.get(&id).filter(|call| is_active(call)) {
            let reply = operation_reply(Some((call.source.slot, id)), op, result)?;
            send(self.outgoing, reply).await?;
        }
        Ok(())
    }
}

fn is_active(call: &Call) -> bool {
    !call.active.is_cancelled() && !call.source.retired.is_cancelled()
}

async fn send(outgoing: &mpsc::Sender<Value>, value: Value) -> Result<(), String> {
    outgoing
        .send(value)
        .await
        .map_err(|_| "Action process write queue closed".into())
}

fn op_error(slot: u64, id: u64, op: u64, error: &str) -> Value {
    json!({"type":"opResult","slot":slot,"call":id,"id":op,"error":error})
}

fn number(message: &Value, key: &str) -> Result<u64, String> {
    message[key]
        .as_u64()
        .filter(|id| *id < 1 << 53)
        .ok_or_else(|| format!("Invalid action process {key}"))
}

async fn drain_stderr(mut stderr: tokio::process::ChildStderr) {
    let mut chunk = [0; 4096];
    while let Ok(n) = stderr.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        for line in String::from_utf8_lossy(&chunk[..n]).lines() {
            tokamak_worker::log(format!("action process: {line}"));
        }
    }
}
