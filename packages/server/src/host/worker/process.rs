#[cfg(windows)]
use super::windows::Child as WorkerChild;
use super::*;
#[cfg(not(windows))]
use std::process::Stdio;
#[cfg(not(windows))]
use tokio::process::Child as WorkerChild;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Child,
    task::JoinSet,
};

struct Call {
    reply: Reply,
    ops: Arc<OpRegistry>,
    active: CancellationToken,
    cancel_at: Option<tokio::time::Instant>,
}
#[cfg(not(windows))]
struct Group(u32);
#[cfg(not(windows))]
impl Drop for Group {
    fn drop(&mut self) {
        // Every descendant inherits this group, including plugin-launched agents.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

#[cfg(not(windows))]
fn guardian(group: u32) -> Result<Option<Child>, String> {
    #[cfg(unix)]
    {
        // stdin is a private liveness pipe. Only the server holds its write end;
        // EOF works even if the worker's JS event loop is blocked indefinitely.
        let mut command = tokio::process::Command::new("/bin/sh");
        command.process_group(group as i32);
        command.args(["-c", "trap '' TERM; while IFS= read -r line; do :; done; kill -TERM -\"$1\" 2>/dev/null; /bin/sleep 0.2; kill -KILL -\"$1\" 2>/dev/null", "worker-guardian", &group.to_string()]);
        command
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map(Some)
            .map_err(|e| format!("Worker guardian could not start: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = group;
        Ok(None)
    }
}

#[cfg(not(windows))]
fn launch(
    id: &str,
    bun: &Path,
    entry: &Path,
    code: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<(WorkerChild, Group, Option<Child>), String> {
    let mut command = tokio::process::Command::new(bun);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .arg(entry)
        .arg(code)
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Plugin {id} worker could not start: {e}"))?;
    let group = Group(child.id().ok_or("Worker has no pid")?);
    let guardian = guardian(group.0)?;
    Ok((child, group, guardian))
}

pub(super) fn spawn(
    runtime: &tokio::runtime::Handle,
    id: &str,
    bun: &Path,
    (entry, code): (Arc<Asset>, Arc<Asset>),
    log: Option<crate::plugin_log::Log>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<Arc<Process>, String> {
    // Nested QuickJS actions can run on a short-lived runtime. Bind child I/O
    // to the server runtime that owns the long-lived worker instead.
    let _entered = runtime.enter();
    #[cfg(windows)]
    let (mut child, containment, mut guardian) = {
        let (child, job) = super::windows::spawn(bun, entry.path(), code.path(), cwd, env)
            .map_err(|e| format!("Plugin {id} worker could not start: {e}"))?;
        (child, job, None::<Child>)
    };
    #[cfg(not(windows))]
    let (mut child, containment, mut guardian) =
        launch(id, bun, entry.path(), code.path(), cwd, env)?;
    let guardian_input = guardian.as_mut().and_then(|child| child.stdin.take());
    let input = child.stdin.take().ok_or("Worker stdin missing")?;
    let output = child.stdout.take().ok_or("Worker stdout missing")?;
    let stderr = child.stderr.take().ok_or("Worker stderr missing")?;
    let (commands, receive) = mpsc::channel(128);
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
        let _guardian_input = guardian_input;
        let label = id.clone();
        let _stderr = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            forward_stderr(label, stderr).await;
        }));
        let (writes, outgoing) = mpsc::channel::<Value>(128);
        let (failed, mut failure) = oneshot::channel();
        let _writer = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            let result = write_messages(input, outgoing).await;
            let _ = failed.send(result.err().unwrap_or_else(|| "Worker stdin closed".into()));
        }));
        let mut calls = BTreeMap::new();
        let mut output = BufReader::new(output);
        let mut frame = Vec::new();
        let mut malformed_log = false;
        let supervise = run(
            (&id, log.as_ref()),
            &mut child,
            (&mut output, &mut frame, &mut malformed_log),
            receive,
            Control {
                input: &writes,
                failure: &mut failure,
                kill: &running.kill,
            },
            &mut calls,
        );
        let error = tokio::select! {
            result = supervise => result,
            status = async {
                match guardian.as_mut() {
                    Some(child) => child.wait().await,
                    None => std::future::pending().await,
                }
            } => Err(format!("Worker guardian exited: {status:?}")),
        }
        .err()
        .unwrap_or_else(|| "Worker stopped".into());
        let _ = writes.try_send(json!({"type":"shutdown"}));
        drop(containment);
        reap(child, guardian).await;
        drain_logs(
            (&id, log.as_ref()),
            &mut output,
            &mut frame,
            &mut malformed_log,
        )
        .await;
        fail_pending_calls(&id, &error, calls);
        running.stopped.cancel();
    });
    Ok(process)
}
async fn reap(mut child: WorkerChild, guardian: Option<Child>) {
    #[cfg(not(windows))]
    let _ = child.kill().await;
    let _ = child.wait().await;
    if let Some(mut guardian) = guardian {
        let _ = guardian.wait().await;
    }
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
    Ok(serde_json::to_vec(value).map_err(|e| e.to_string())?.len() >= FRAME)
}
struct Control<'a> {
    input: &'a mpsc::Sender<Value>,
    failure: &'a mut oneshot::Receiver<String>,
    kill: &'a CancellationToken,
}
async fn run(
    (id, log): (&str, Option<&crate::plugin_log::Log>),
    child: &mut WorkerChild,
    (output, frame, malformed_log): (
        &mut BufReader<tokio::process::ChildStdout>,
        &mut Vec<u8>,
        &mut bool,
    ),
    mut commands: mpsc::Receiver<Command>,
    control: Control<'_>,
    calls: &mut BTreeMap<u64, Call>,
) -> Result<(), String> {
    let Control {
        input,
        failure,
        kill,
    } = control;
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
            status = child.wait() => return Err(format!("process exited ({status:?})")),
            error = &mut *failure => return Err(error.unwrap_or_else(|_| "stdin writer closed".into())),
            Some(result) = ops.join_next() => {
                forward_operation_result(result, calls, input)?;
            },
            command = commands.recv() => match command {
                Some(Command::Invoke {id, name, args, ops, reply}) => {
                    if calls.len() >= 128 { let _ = reply.send(Err("Worker invocation capacity exceeded".into())); continue; }
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
            line = read_frame(output, frame) => {
                let line = line?.ok_or("stdout closed")?;
                let Some(message) = worker_message(id, &line, malformed_log)? else { continue };
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
                        if ops.len() >= 128 { return Err("Worker operation capacity exceeded".into()); }
                        let name = message["name"].as_str().ok_or("Invalid worker op name")?.to_owned();
                        let payload = message.get("payload").ok_or("Worker op has no payload")?.clone();
                        let registry = call.ops.clone(); let active = call.active.clone();
                        ops.spawn(async move {
                            let result = tokio::select! { biased; _ = active.cancelled() => Err("stale invocation".into()), result = registry.dispatch(&name, payload) => result };
                            (call_id, op, result)
                        });
                    }
                    Some("log") => store_log(id, log, &message),
                    _ => return Err("Invalid worker message".into()),
                }
            }
        }
    }
}
async fn drain_logs(
    (id, log): (&str, Option<&crate::plugin_log::Log>),
    output: &mut (impl AsyncBufRead + Unpin),
    frame: &mut Vec<u8>,
    malformed_log: &mut bool,
) {
    // A reload or process exit can win the select with complete log frames
    // still in the pipe. Drain them before a reload clears the log.
    let drained = tokio::time::timeout(GRACE, async {
        while let Some(bytes) = read_frame(output, frame).await? {
            if let Ok(Some(message)) = worker_message(id, &bytes, malformed_log)
                && message["type"] == "log"
            {
                store_log(id, log, &message);
            }
        }
        Ok::<(), String>(())
    })
    .await;
    match drained {
        Ok(Ok(())) => (),
        Ok(Err(error)) => logs::send(format!("Plugin {id} worker: {error}")),
        Err(_) => logs::send(format!("Plugin {id} worker: timeout draining plugin log")),
    }
}

const LOG_PREFIX: &[u8] = br#"{"type":"log""#;
const OVERLONG_LOG: &[u8] = br#"{"type":"log","oversized":"#;

fn worker_message(id: &str, bytes: &[u8], diagnosed: &mut bool) -> Result<Option<Value>, String> {
    let decoded = serde_json::from_slice::<Value>(bytes);
    match decoded {
        Ok(message)
            if message["type"] != "log"
                || (message["level"].is_string() && message["text"].is_string()) =>
        {
            Ok(Some(message))
        }
        Ok(_) => {
            malformed_log(id, diagnosed);
            Ok(None)
        }
        Err(_) if bytes.starts_with(LOG_PREFIX) => {
            malformed_log(id, diagnosed);
            Ok(None)
        }
        Err(_) => Err("Invalid worker JSON".into()),
    }
}

fn malformed_log(id: &str, diagnosed: &mut bool) {
    if !std::mem::replace(diagnosed, true) {
        logs::send(format!("Plugin {id} worker: dropped malformed log frame"));
    }
}

fn store_log(id: &str, log: Option<&crate::plugin_log::Log>, message: &Value) {
    let level = crate::plugin_log::console_level(message["level"].as_str().unwrap_or("info"));
    let text = message["text"].as_str().unwrap_or("");
    if let Some(log) = log {
        log.record("server", level, "console", text);
    } else {
        logs::send(format!("Plugin {id} [{level}]: {text}"));
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
        if frame == OVERLONG_LOG {
            // Discard the rest of an oversized log frame without growing the buffer.
        } else if frame.len() + count > FRAME {
            if !frame.starts_with(LOG_PREFIX) {
                return Err("Worker message exceeds 1 MiB limit".into());
            }
            frame.clear();
            frame.extend_from_slice(OVERLONG_LOG);
        } else {
            frame.extend_from_slice(&bytes[..count]);
        }
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
        if bytes.len() > FRAME {
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
