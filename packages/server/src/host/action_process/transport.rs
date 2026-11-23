use std::collections::HashMap;

use tokio::{
    io::{AsyncReadExt, BufReader},
    task::JoinSet,
};
use tokio_util::task::AbortOnDropHandle;

use super::*;
use crate::host::worker::process::{oversized, read_frame, write_messages};

type OpResult = (u64, u64, Result<Value, String>);

pub(super) fn start(runtime: &Handle) -> Result<Arc<Running>, String> {
    let _entered = runtime.enter();
    let mut child = tokamak_worker::Process::launch_actions()
        .map_err(|error| format!("Action process could not start: {error}"))?;
    let (input, output, stderr) = child.pipes()?;
    let (commands, receive) = mpsc::unbounded_channel();
    let process = Arc::new(Running {
        commands,
        stop: CancellationToken::new(),
        ended: CancellationToken::new(),
        healthy: AtomicBool::new(false),
        started: Instant::now(),
    });

    let running = process.clone();
    let finished = process.ended.clone().drop_guard();
    runtime.spawn(async move {
        let _finished = finished;
        let _stderr = AbortOnDropHandle::new(tokio::spawn(drain_stderr(stderr)));
        let (outgoing, writes) = mpsc::channel(WORKER_CAPACITY * 2);
        let mut calls = HashMap::new();
        let error = tokio::select! {
            biased;
            () = running.stop.cancelled() => "Action process stopped".into(),
            error = child.exited() => format!("Action process exited: {error}"),
            result = write_messages(input, writes) =>
                format!("Action process exited: {}", result.err().unwrap_or_else(|| "stdin closed".into())),
            result = exchange(&running, &outgoing, BufReader::new(output), receive, &mut calls) =>
                format!("Action process exited: {}", result.err().unwrap_or_else(|| "stdout closed".into())),
        };
        child.stop().await;
        running.stop.cancel();

        for (_, call) in calls {
            call.active.cancel();
            let _ = call.reply.send(Err(error.clone()));
        }
    });
    Ok(process)
}

async fn exchange(
    process: &Running,
    outgoing: &mpsc::Sender<Value>,
    mut output: BufReader<tokio::process::ChildStdout>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    calls: &mut HashMap<u64, Box<Call>>,
) -> Result<(), String> {
    let mut broker = Broker {
        process,
        outgoing,
        calls,
        ops: JoinSet::new(),
        plugins: HashMap::new(),
    };
    let mut buffer = Vec::new();
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(command) => broker.command(command)?,
                None => return Ok(()),
            },
            Some(result) = broker.ops.join_next() => {
                if let Ok(result) = result {
                    broker.forward_op_result(result)?;
                }
            }
            frame = read_frame(&mut output, &mut buffer) => {
                let Some(frame) = frame? else { return Ok(()) };
                broker.message(serde_json::from_slice(&frame).map_err(|e| e.to_string())?)?;
            }
        }
    }
}

struct Broker<'a> {
    process: &'a Running,
    outgoing: &'a mpsc::Sender<Value>,
    calls: &'a mut HashMap<u64, Box<Call>>,
    ops: JoinSet<OpResult>,
    plugins: HashMap<u64, String>,
}

impl Broker<'_> {
    fn command(&mut self, command: Command) -> Result<(), String> {
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
                send(self.outgoing, frame)
            }
            Command::Cancel(id) => {
                if let Some(call) = self.calls.remove(&id) {
                    call.active.cancel();
                    send(
                        self.outgoing,
                        json!({"type":"cancel","slot":call.source.slot,"id":id}),
                    )?;
                }
                Ok(())
            }
            Command::Retire(slot) => {
                if self.plugins.remove(&slot).is_some() {
                    self.calls.retain(|_, call| call.source.slot != slot);
                    send(self.outgoing, json!({"type":"drop","slot":slot}))?;
                }
                Ok(())
            }
        }
    }

    fn message(&mut self, message: Value) -> Result<(), String> {
        let slot = number(&message, "slot")?;
        match message["type"].as_str() {
            Some("result") => self.result(slot, message),
            Some("op") => self.operation(slot, message),
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
            if self.process.started.elapsed() >= HEALTHY_UPTIME {
                self.process.healthy.store(true, Ordering::Release);
            }
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

    fn operation(&mut self, slot: u64, message: Value) -> Result<(), String> {
        let id = number(&message, "call")?;
        let op = number(&message, "id")?;
        let authorized = self.calls.get(&id).filter(|call| {
            call.source.slot == slot && is_active(call) && message.get("plugin").is_none()
        });
        let Some(call) = authorized else {
            return send(
                self.outgoing,
                op_error(slot, id, op, "stale invocation: host operation refused"),
            );
        };
        if self.ops.len() >= WORKER_CAPACITY {
            return send(
                self.outgoing,
                op_error(slot, id, op, "Action process operation capacity exceeded"),
            );
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
            (id, op, result)
        });
        Ok(())
    }

    fn forward_op_result(&self, (id, op, result): OpResult) -> Result<(), String> {
        if let Some(call) = self.calls.get(&id).filter(|call| is_active(call)) {
            let slot = call.source.slot;
            let mut reply = match result {
                Ok(value) => json!({"type":"opResult","slot":slot,"call":id,"id":op,"value":value}),
                Err(error) => op_error(slot, id, op, &error),
            };
            if oversized(&reply)? {
                reply = op_error(
                    slot,
                    id,
                    op,
                    "Host operation result exceeds 1 MiB worker limit",
                );
            }
            send(self.outgoing, reply)?;
        }
        Ok(())
    }
}

fn is_active(call: &Call) -> bool {
    !call.active.is_cancelled() && !call.source.retired.is_cancelled()
}

fn send(outgoing: &mpsc::Sender<Value>, value: Value) -> Result<(), String> {
    outgoing
        .try_send(value)
        .map_err(|_| "Action process write queue full or closed".into())
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
        tokamak_worker::log(format!(
            "Action process: {}",
            String::from_utf8_lossy(&chunk[..n])
        ));
    }
}
