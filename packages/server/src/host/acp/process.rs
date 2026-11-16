use super::{
    config::Agent,
    limits,
    session::{Events, Turn},
};
use agent_client_protocol::{schema::ProtocolVersion, v1::schema::InitializeRequest};
use serde_json::{Value, json};
use std::{collections::BTreeMap, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdout},
    sync::{mpsc, oneshot},
};

pub(super) type Reply = oneshot::Sender<Result<Value, String>>;

pub(super) enum Pending {
    Request(Reply),
    Restore { session: String, reply: Reply },
    Prompt(String),
}

pub(super) enum Command {
    Request {
        method: String,
        params: Value,
        reply: Reply,
    },
    Prompt {
        owner: String,
        session: String,
        text: String,
        events: Events,
        reply: Reply,
    },
    Respond {
        owner: String,
        request: String,
        option: Option<String>,
        reply: Reply,
    },
    Cancel {
        owner: Option<String>,
        session: String,
    },
}

pub(super) struct Process {
    commands: mpsc::UnboundedSender<Command>,
    pub capabilities: Value,
}

impl Process {
    pub async fn spawn(agent: &Agent, env: BTreeMap<String, String>) -> Result<Arc<Self>, String> {
        // The SDK's process launcher inherits env; this boundary must clear it.
        let mut command = tokio::process::Command::new(&agent.command);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .args(&agent.args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Cannot start ACP agent: {e}"))?;
        #[cfg(unix)]
        let group = ProcessGroup(child.id().ok_or("ACP process has no pid")?);
        let mut input = child.stdin.take().ok_or("ACP stdin missing")?;
        let output = child.stdout.take().ok_or("ACP stdout missing")?;
        let mut stderr = child.stderr.take().ok_or("ACP stderr missing")?;
        let tail = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let captured = tail.clone();
        let stderr_task = tokio::spawn(async move {
            let mut buffer = [0; 1024];
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let mut tail = captured.lock().expect("ACP stderr");
                tail.extend_from_slice(&buffer[..count]);
                let excess = tail.len().saturating_sub(limits::STDERR_BYTES);
                tail.drain(..excess);
            }
        });
        let (commands, receive) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (writes, mut outgoing) = mpsc::channel::<Vec<u8>>(limits::WRITE_QUEUE);
            let (write_error, mut failed_write) = oneshot::channel();
            let _writer = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
                while let Some(bytes) = outgoing.recv().await {
                    let error =
                        match tokio::time::timeout(limits::WRITE_TIMEOUT, input.write_all(&bytes))
                            .await
                        {
                            Ok(Ok(())) => continue,
                            Ok(Err(error)) => format!("ACP write failed: {error}"),
                            Err(_) => "ACP stdin write timed out after 10 s".into(),
                        };
                    let _ = write_error.send(error);
                    return;
                }
            }));
            let mut actor = Actor {
                input: writes,
                next: 0,
                pending: BTreeMap::new(),
                turns: BTreeMap::new(),
            };
            let error = actor
                .run(&mut child, output, receive, &mut failed_write)
                .await;
            #[cfg(unix)]
            drop(group);
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            let tail = tail.lock().expect("ACP stderr");
            let error = format!("{error}: {}", String::from_utf8_lossy(&tail));
            for (_, pending) in actor.pending {
                if let Pending::Request(reply) | Pending::Restore { reply, .. } = pending {
                    let _ = reply.send(Err(error.clone()));
                }
            }
            for (_, turn) in actor.turns {
                let _ = turn.events.send(Err(error.clone()));
            }
        });
        let mut process = Self {
            commands,
            capabilities: Value::Null,
        };
        let initialize = serde_json::to_value(InitializeRequest::new(ProtocolVersion::V1))
            .map_err(|e| e.to_string())?;
        let result = process.request("initialize", initialize).await?;
        if result["protocolVersion"] != 1 {
            return Err("ACP agent does not support protocol v1".into());
        }
        process.capabilities = result["agentCapabilities"].clone();
        Ok(Arc::new(process))
    }

    pub fn closed(&self) -> bool {
        self.commands.is_closed()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let (reply, wait) = oneshot::channel();
        self.send(Command::Request {
            method: method.into(),
            params,
            reply,
        })?;
        wait.await.map_err(|_| "ACP process closed".to_owned())?
    }

    pub async fn prompt(
        &self,
        owner: &str,
        session: &str,
        text: &str,
        events: Events,
    ) -> Result<Value, String> {
        let (reply, wait) = oneshot::channel();
        self.send(Command::Prompt {
            owner: owner.into(),
            session: session.into(),
            text: text.into(),
            events,
            reply,
        })?;
        wait.await.map_err(|_| "ACP process closed".to_owned())?
    }

    pub async fn respond(
        &self,
        owner: &str,
        request: &str,
        option: Option<String>,
    ) -> Result<Value, String> {
        let (reply, wait) = oneshot::channel();
        self.send(Command::Respond {
            owner: owner.into(),
            request: request.into(),
            option,
            reply,
        })?;
        wait.await.map_err(|_| "ACP process closed".to_owned())?
    }

    pub fn cancel(&self, owner: &str, session: &str) {
        let _ = self.send(Command::Cancel {
            owner: Some(owner.into()),
            session: session.into(),
        });
    }

    pub fn cancel_session(&self, session: &str) {
        let _ = self.send(Command::Cancel {
            owner: None,
            session: session.into(),
        });
    }

    fn send(&self, command: Command) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "ACP process closed".into())
    }
}

pub(super) struct Actor {
    pub(super) input: mpsc::Sender<Vec<u8>>,
    pub(super) next: u64,
    pub(super) pending: BTreeMap<u64, Pending>,
    pub(super) turns: BTreeMap<String, Turn>,
}

impl Actor {
    pub(super) async fn write(&mut self, message: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if bytes.len() > limits::FRAME_BYTES {
            return Err("ACP outgoing frame exceeds 1 MiB limit".into());
        }
        self.input
            .try_send(bytes)
            .map_err(|_| "ACP stdin write queue full or closed".into())
    }

    pub(super) async fn request(
        &mut self,
        method: String,
        params: Value,
        pending: Pending,
    ) -> Result<(), String> {
        self.next += 1;
        self.pending.insert(self.next, pending);
        self.write(json!({"jsonrpc":"2.0", "id":self.next, "method":method, "params":params}))
            .await
    }

    async fn run(
        &mut self,
        child: &mut Child,
        output: ChildStdout,
        mut commands: mpsc::UnboundedReceiver<Command>,
        failed_write: &mut oneshot::Receiver<String>,
    ) -> String {
        let mut output = BufReader::new(output);
        let mut frame = Vec::new();
        loop {
            let idle = tokio::time::sleep(limits::IDLE_TIMEOUT);
            tokio::pin!(idle);
            let result = tokio::select! {
                command = commands.recv() => match command {
                    Some(command) => self.command(command).await,
                    None => return "ACP manager closed".into(),
                },
                line = read_frame(&mut output, &mut frame) => match line {
                    Ok(Some(line)) => match serde_json::from_slice(&line) {
                        Ok(message) => self.message(message).await,
                        Err(_) => return "Invalid ACP message".into(),
                    },
                    Ok(None) => return "ACP process exited".into(),
                    Err(error) => return format!("ACP read failed: {error}"),
                },
                error = &mut *failed_write => return error.unwrap_or_else(|_| "ACP stdin writer closed".into()),
                status = child.wait() => return format!("ACP process exited ({status:?})"),
                _ = &mut idle, if self.pending.is_empty() && self.turns.is_empty() => return "ACP idle timeout".into(),
            };
            if let Err(error) = result {
                return error;
            }
        }
    }
}

#[cfg(unix)]
struct ProcessGroup(u32);

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // The child leads a private group, including wrapper-launched agents.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

// Keep the partial frame outside the select future so command traffic cannot
// discard bytes. Never allocate more than the frame limit, even without a newline.
async fn read_frame(
    output: &mut BufReader<ChildStdout>,
    frame: &mut Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    loop {
        let available = output.fill_buf().await.map_err(|e| e.to_string())?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Ok(Some(std::mem::take(frame)))
            };
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(available.len(), |index| index + 1);
        if frame.len() + count > limits::FRAME_BYTES {
            return Err("ACP frame exceeds 1 MiB limit".into());
        }
        frame.extend_from_slice(&available[..count]);
        output.consume(count);
        if end.is_some() {
            return Ok(Some(std::mem::take(frame)));
        }
    }
}
