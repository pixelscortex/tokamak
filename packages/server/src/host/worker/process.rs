use super::*;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    task::JoinSet,
};

struct Call {
    reply: Reply,
    ops: Arc<OpRegistry>,
    active: CancellationToken,
    cancel_at: Option<tokio::time::Instant>,
}
pub(super) fn spawn(
    runtime: &tokio::runtime::Handle,
    id: &str,
    bun: &Path,
    entry: Arc<Asset>,
    code: Arc<Asset>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<Arc<Process>, String> {
    // Nested QuickJS actions can run on a short-lived runtime. Bind child I/O
    // to the server runtime that owns the long-lived worker instead.
    let _entered = runtime.enter();
    let mut child =
        tokamak_worker::Process::launch(bun, entry.path(), code.path(), cwd, env, Lane::Action)
            .map_err(|error| format!("Plugin {id} worker could not start: {error}"))?;
    let (input, output, stderr) = child.pipes()?;
    let (commands, receive) = mpsc::channel(WORKER_CAPACITY);
    let process = Arc::new(Process {
        commands,
        kill: CancellationToken::new(),
        stopped: CancellationToken::new(),
    });
    let running = process.clone();
    let id = id.to_owned();
    let finished = process.stopped.clone().drop_guard();
    runtime.spawn(async move {
        let _finished = finished;
        // Keep the verified snapshots alive through exit; never reopen build output.
        let _snapshots = (entry, code);
        let label = id.clone();
        let _stderr = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            forward_stderr(label, stderr).await;
        }));
        let (writes, outgoing) = mpsc::channel::<Value>(WORKER_CAPACITY);
        let (failed, mut failure) = oneshot::channel();
        let _writer = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            let result = write_messages(input, outgoing).await;
            let _ = failed.send(result.err().unwrap_or_else(|| "Worker stdin closed".into()));
        }));
        let mut calls = BTreeMap::new();
        let error = tokio::select! {
            result = run(&id, output, receive, Control {
                input: &writes,
                failure: &mut failure,
                kill: &running.kill,
            }, &mut calls) => result.err().unwrap_or_else(|| "Worker stopped".into()),
            error = child.exited() => error,
        };
        let _ = writes.try_send(json!({"type":"shutdown"}));
        child.stop().await;
        fail_pending_calls(&id, &error, calls);
        running.stopped.cancel();
    });
    Ok(process)
}
fn write(input: &mpsc::Sender<Value>, value: Value) -> Result<(), String> {
    if oversized(&value)? {
        return Err("Worker message exceeds 1 MiB limit".into());
    }
    input
        .try_send(value)
        .map_err(|_| "Worker write queue full or closed".into())
}
fn oversized(value: &Value) -> Result<bool, String> {
    Ok(serde_json::to_vec(value).map_err(|e| e.to_string())?.len() >= WORKER_FRAME_BYTES)
}
struct Control<'a> {
    input: &'a mpsc::Sender<Value>,
    failure: &'a mut oneshot::Receiver<String>,
    kill: &'a CancellationToken,
}
async fn run(
    id: &str,
    output: tokio::process::ChildStdout,
    mut commands: mpsc::Receiver<Command>,
    control: Control<'_>,
    calls: &mut BTreeMap<u64, Call>,
) -> Result<(), String> {
    let Control {
        input,
        failure,
        kill,
    } = control;
    let mut output = BufReader::new(output);
    let mut frame = Vec::new();
    let mut ops = JoinSet::new();
    loop {
        let deadline = calls.values().filter_map(|call| call.cancel_at).min();
        let cancelled = async {
            match deadline {
                Some(end) => tokio::time::sleep_until(end).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = kill.cancelled() => return Err("worker stopped".into()),
            _ = cancelled => return Err("action cancellation timed out".into()),
            error = &mut *failure => return Err(error.unwrap_or_else(|_| "stdin writer closed".into())),
            Some(result) = ops.join_next() => {
                forward_operation_result(result, calls, input)?;
            },
            command = commands.recv() => match command {
                Some(Command::Invoke {id, name, args, ops, reply}) => {
                    if calls.len() >= WORKER_CAPACITY { let _ = reply.send(Err("Worker invocation capacity exceeded".into())); continue; }
                    let message = json!({"type":"invoke","id":id,"fn":name,"args":args});
                    if oversized(&message)? {
                        let _ = reply.send(Err("Worker invocation exceeds 1 MiB limit".into()));
                        continue;
                    }
                    calls.insert(id, Call {reply, ops, active: CancellationToken::new(), cancel_at: None});
                    write(input, message)?;
                }
                Some(Command::Cancel(id)) => if let Some(call) = calls.get_mut(&id) {
                    call.active.cancel();
                    call.cancel_at.get_or_insert(tokio::time::Instant::now() + GRACE);
                    write(input, json!({"type":"cancel","id":id}))?;
                },
                None => return Err("worker owner closed".into()),
            },
            line = read_frame(&mut output, &mut frame) => {
                let line = line?.ok_or("stdout closed")?;
                let message: Value = serde_json::from_slice(&line).map_err(|_| "Invalid worker JSON")?;
                match message["type"].as_str() {
                    Some("result") => {
                        let id = message["id"].as_u64().ok_or("Invalid worker call id")?;
                        if let Some(call) = calls.remove(&id) {
                            let result = if call.active.is_cancelled() { Err("Plugin action cancelled".into()) }
                                else if let Some(error) = message.get("error") { Err(error.as_str().ok_or("Invalid worker error")?.to_owned()) }
                                else { Ok(message.get("value").ok_or("Worker result has no value")?.clone()) };
                            call.active.cancel();
                            let _ = call.reply.send(result);
                        }
                    }
                    Some("op") => {
                        let call_id = message["call"].as_u64().ok_or("Invalid worker call id")?;
                        let op = message["id"].as_u64().ok_or("Invalid worker op id")?;
                        let Some(call) = calls.get(&call_id).filter(|c| !c.active.is_cancelled()) else {
                            write(input, json!({"type":"opResult","id":op,"error":"stale invocation: host operation refused"}))?; continue;
                        };
                        if ops.len() >= WORKER_CAPACITY { return Err("Worker operation capacity exceeded".into()); }
                        let name = message["name"].as_str().ok_or("Invalid worker op name")?.to_owned();
                        let payload = message.get("payload").ok_or("Worker op has no payload")?.clone();
                        let registry = call.ops.clone(); let active = call.active.clone();
                        ops.spawn(async move {
                            let result = tokio::select! { biased; _ = active.cancelled() => Err("stale invocation".into()), result = registry.dispatch(&name, payload) => result };
                            (call_id, op, result)
                        });
                    }
                    Some("log") => logs::send(format!("Plugin {id} [{}]: {}", message["level"].as_str().unwrap_or("info"), message["text"].as_str().unwrap_or(""))),
                    _ => return Err("Invalid worker message".into()),
                }
            }
        }
    }
}
// fill_buf is cancellation-safe. Keep the partial frame across select branches.
async fn read_frame(
    output: &mut (impl AsyncBufRead + Unpin),
    frame: &mut Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    loop {
        let bytes = output.fill_buf().await.map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("Incomplete worker message".into())
            };
        }
        let end = bytes.iter().position(|b| *b == b'\n');
        let count = end.map_or(bytes.len(), |n| n + 1);
        if frame.len() + count > WORKER_FRAME_BYTES {
            return Err("Worker message exceeds 1 MiB limit".into());
        }
        frame.extend_from_slice(&bytes[..count]);
        output.consume(count);
        if end.is_some() {
            return Ok(Some(std::mem::take(frame)));
        }
    }
}

async fn forward_stderr(label: String, mut stderr: tokio::process::ChildStderr) {
    let mut chunk = [0u8; 4096];
    while let Ok(n) = stderr.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        logs::send(format!(
            "Plugin {label}: {}",
            String::from_utf8_lossy(&chunk[..n])
        ));
    }
}

async fn write_messages(
    mut input: tokio::process::ChildStdin,
    mut outgoing: mpsc::Receiver<Value>,
) -> Result<(), String> {
    while let Some(message) = outgoing.recv().await {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if bytes.len() > WORKER_FRAME_BYTES {
            return Err("Worker message exceeds 1 MiB limit".into());
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            input.write_all(&bytes).await?;
            // Tokio's Windows pipe writes can finish in its blocking pool.
            #[cfg(windows)]
            input.flush().await?;
            Ok::<_, std::io::Error>(())
        })
        .await
        .map_err(|_| "Worker stdin stalled")?
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn fail_pending_calls(id: &str, error: &str, calls: BTreeMap<u64, Call>) {
    for (_, call) in calls {
        call.active.cancel();
        let _ = call
            .reply
            .send(Err(format!("Plugin {id} worker exited: {error}")));
    }
}

fn forward_operation_result(
    result: Result<(u64, u64, Result<Value, String>), tokio::task::JoinError>,
    calls: &BTreeMap<u64, Call>,
    input: &mpsc::Sender<Value>,
) -> Result<(), String> {
    if let Ok((call, op, result)) = result
        && calls.get(&call).is_some_and(|c| !c.active.is_cancelled())
    {
        let mut message = match result {
            Ok(value) => json!({"type":"opResult","id":op,"value":value}),
            Err(error) => json!({"type":"opResult","id":op,"error":error}),
        };
        if oversized(&message)? {
            message = json!({"type":"opResult","id":op,"error":"Host operation result exceeds 1 MiB worker limit"});
        }
        write(input, message)?;
    }

    Ok(())
}
