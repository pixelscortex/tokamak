use std::{
    collections::HashMap,
    io,
    os::unix::process::ExitStatusExt,
    process::Stdio,
    sync::{Arc, Mutex},
};

use tokio::{
    io::{AsyncRead, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, watch},
};

const INPUT_QUEUE_BYTES: u32 = 64 * 1024 * 1024;

pub type Exit = Result<i32, String>;
type Input = (Vec<u8>, OwnedSemaphorePermit);

pub struct Program {
    group: i32,
    control: Mutex<Control>,
    input_budget: Arc<Semaphore>,
    stop_input: Notify,
    exit: watch::Receiver<Option<Exit>>,
    done: watch::Receiver<bool>,
}

struct Control {
    guardian: Option<ChildStdin>,
    input: Option<mpsc::UnboundedSender<Input>>,
    failed_outputs: Vec<Box<dyn AsyncRead + Unpin + Send>>,
    group_live: bool,
}

impl Program {
    pub fn spawn(
        argv: &[String],
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
    ) -> io::Result<(Arc<Self>, ChildStdout, ChildStderr)> {
        let Some((executable, args)) = argv.split_first() else {
            return Err(io::Error::other("Expected a program command"));
        };

        let mut guardian = spawn_guardian()?;
        let group = guardian
            .id()
            .ok_or_else(|| io::Error::other("Missing guardian PID"))? as i32;
        let liveness = guardian.stdin.take();
        let child = spawn_child(executable, args, cwd.as_deref(), env.as_ref(), group);

        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                let _ = guardian.start_kill();
                drop(liveness);
                tokio::spawn(async move {
                    let _ = guardian.wait().await;
                });
                return Err(error);
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Missing program stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("Missing program stderr"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Missing program stdin"))?;

        let (input, writes) = mpsc::unbounded_channel();
        let (exit, exited) = watch::channel(None);
        let (done, finished) = watch::channel(false);
        let program = Arc::new(Self {
            group,
            control: Mutex::new(Control {
                guardian: liveness,
                input: Some(input),
                failed_outputs: Vec::new(),
                group_live: true,
            }),
            input_budget: Arc::new(Semaphore::new(INPUT_QUEUE_BYTES as usize)),
            stop_input: Notify::new(),
            exit: exited,
            done: finished,
        });
        tokio::spawn(drive(
            program.clone(),
            child,
            guardian,
            stdin,
            writes,
            exit,
            done,
        ));
        Ok((program, stdout, stderr))
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), &'static str> {
        let control = self.control.lock().expect("program control");
        if !bytes.is_empty()
            && let Some(input) = &control.input
            && !input.is_closed()
        {
            let limit = "Program input queue exceeds 64 MiB";
            let size = u32::try_from(bytes.len()).map_err(|_| limit)?;
            let permit = self
                .input_budget
                .clone()
                .try_acquire_many_owned(size)
                .map_err(|_| limit)?;
            let _ = input.send((bytes.to_vec(), permit));
        }
        Ok(())
    }

    pub fn hold_failed_output(&self, pipe: impl AsyncRead + Unpin + Send + 'static) {
        let mut control = self.control.lock().expect("program control");
        if control.group_live {
            // Keep the pipe open independently of the failed JS iterator.
            control.failed_outputs.push(Box::new(pipe));
        }
    }

    pub fn close_input(&self) {
        self.control.lock().expect("program control").input.take();
    }

    pub fn stop(&self, force: bool) {
        let mut control = self.control.lock().expect("program control");
        if force && control.group_live {
            // SAFETY: The group was created for this program, with the
            // guardian as leader. Its watchdog sends the same group signal.
            unsafe { libc::kill(-self.group, libc::SIGKILL) };
            control.group_live = false;
        }
        control.guardian.take();
        self.stop_input.notify_one();
        control.input.take();
    }

    pub async fn exited(&self) -> Exit {
        self.exit
            .clone()
            .wait_for(Option::is_some)
            .await
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or_else(|| "Program did not report its exit status".to_owned())?
    }

    pub async fn stopped(&self) {
        let _ = self.done.clone().wait_for(|done| *done).await;
    }

    pub fn finished(&self) -> bool {
        *self.done.borrow()
    }
}

fn spawn_child(
    executable: &str,
    args: &[String],
    cwd: Option<&str>,
    env: Option<&HashMap<String, String>>,
    group: i32,
) -> io::Result<Child> {
    let spawn = |mut command: Command| {
        command.process_group(group);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = env {
            command.env_clear().envs(env);
        }
        tokamak_worker::inherit_only(command.as_std_mut(), None)?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    };

    let mut command = Command::new(executable);
    command.args(args);
    spawn(command).or_else(|error| {
        let (code, reason) = match error.raw_os_error() {
            Some(libc::ENOENT | libc::ENOTDIR) => ("127", "not found"),
            Some(libc::EACCES | libc::ENOEXEC | libc::EPERM | libc::EISDIR) => {
                ("126", "Permission denied")
            }
            _ => return Err(error),
        };

        // Report an exec failure through the program's stderr and status.
        // Using the same cwd also distinguishes a failed chdir from exec.
        let mut fallback = Command::new("/bin/sh");
        fallback.args([
            "-c",
            r#"printf '%s: exec: %s: %s\n' "$0" "$1" "$2" >&2; exit "$3""#,
            "tokamak-program",
            executable,
            reason,
            code,
        ]);
        spawn(fallback).map_err(|error| {
            if let Some(cwd) = cwd
                && matches!(
                    error.raw_os_error(),
                    Some(libc::ENOENT | libc::ENOTDIR | libc::EACCES | libc::EPERM)
                )
            {
                return io::Error::other(format!(
                    "Could not use working directory {cwd:?}: {error}"
                ));
            }
            error
        })
    })
}

fn spawn_guardian() -> io::Result<Child> {
    // The guardian leads the group before the executable starts. Its
    // private stdin is the liveness pipe; the executable never inherits it.
    let mut guardian = Command::new("/bin/sh");
    guardian
        .process_group(0)
        .args([
            "-c",
            r#"while IFS= read -r line; do :; done
kill -TERM "-$$" 2>/dev/null
/bin/sleep 0.25
kill -KILL "-$$" 2>/dev/null"#,
            "program-guardian",
        ])
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: Only an async-signal-safe syscall runs before exec. The
    // guardian must ignore TERM even before its shell begins executing.
    unsafe {
        guardian.pre_exec(|| {
            if libc::signal(libc::SIGTERM, libc::SIG_IGN) == libc::SIG_ERR {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    tokamak_worker::inherit_only(guardian.as_std_mut(), None)?;
    guardian.spawn()
}

async fn drive(
    program: Arc<Program>,
    mut child: Child,
    mut guardian: Child,
    mut stdin: ChildStdin,
    mut writes: mpsc::UnboundedReceiver<Input>,
    exit: watch::Sender<Option<Exit>>,
    done: watch::Sender<bool>,
) {
    let wait_child = async {
        let status = tokio::select! {
            biased;
            status = child.wait() => Some(status),
            _ = program.stop_input.notified() => None,
            _ = drive_input(&mut stdin, &mut writes) => {
                drop(stdin);
                None
            }
        };
        drop(writes);

        // During stop, leave stdin open so EOF cannot preempt the TERM handler.
        let status = match status {
            Some(status) => status,
            None => child.wait().await,
        };

        // A program can exit while a descendant still holds its pipes.
        program.stop(false);
        let code = status
            .map(|status| {
                status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
            })
            .map_err(|error| error.to_string());
        exit.send_replace(Some(code));
    };
    let wait_group = async {
        let _ = guardian.wait().await;
        let mut control = program.control.lock().expect("program control");
        control.group_live = false;
        control.failed_outputs.clear();
    };
    tokio::join!(wait_child, wait_group);
    done.send_replace(true);
}

async fn drive_input(
    stdin: &mut ChildStdin,
    writes: &mut mpsc::UnboundedReceiver<Input>,
) -> io::Result<()> {
    while let Some((bytes, _permit)) = writes.recv().await {
        stdin.write_all(&bytes).await?;
    }
    Ok(())
}
