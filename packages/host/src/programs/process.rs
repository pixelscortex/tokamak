use std::{
    collections::HashMap,
    io,
    os::unix::process::ExitStatusExt,
    process::Stdio,
    sync::{Arc, Mutex},
};

use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{mpsc, watch},
};

pub type Exit = Result<i32, String>;

pub struct Program {
    group: i32,
    control: Mutex<Control>,
    exit: watch::Receiver<Option<Exit>>,
    done: watch::Receiver<bool>,
}

struct Control {
    guardian: Option<ChildStdin>,
    input: Option<mpsc::UnboundedSender<Vec<u8>>>,
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
        let mut command = Command::new(executable);
        command.process_group(group).args(args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = env {
            command.env_clear().envs(env);
        }
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

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

        let (input, writes) = mpsc::unbounded_channel::<Vec<u8>>();
        let (exit, exited) = watch::channel(None);
        let (done, finished) = watch::channel(false);
        let program = Arc::new(Self {
            group,
            control: Mutex::new(Control {
                guardian: liveness,
                input: Some(input),
                group_live: true,
            }),
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

    pub fn write(&self, bytes: &[u8]) {
        if !bytes.is_empty()
            && let Some(input) = &self.control.lock().expect("program control").input
            && !input.is_closed()
        {
            let _ = input.send(bytes.to_vec());
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
    guardian.spawn()
}

async fn drive(
    program: Arc<Program>,
    mut child: Child,
    mut guardian: Child,
    stdin: ChildStdin,
    writes: mpsc::UnboundedReceiver<Vec<u8>>,
    exit: watch::Sender<Option<Exit>>,
    done: watch::Sender<bool>,
) {
    let wait_child = async {
        let status = tokio::select! {
            status = child.wait() => status,
            _ = drive_input(stdin, writes) => child.wait().await,
        };
        program.close_input();
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
        program.control.lock().expect("program control").group_live = false;
    };
    tokio::join!(wait_child, wait_group);
    done.send_replace(true);
}

async fn drive_input(
    mut stdin: ChildStdin,
    mut writes: mpsc::UnboundedReceiver<Vec<u8>>,
) -> io::Result<()> {
    while let Some(bytes) = writes.recv().await {
        stdin.write_all(&bytes).await?;
    }
    Ok(())
}
