use std::{
    collections::HashMap,
    io,
    os::unix::process::ExitStatusExt,
    process::Stdio,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncRead, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, watch},
};

const INPUT_QUEUE_BYTES: u32 = 64 * 1024 * 1024;
const PROGRAM_TERM_GRACE: Duration = Duration::from_secs(2);
const GROUP_CHECK_INTERVAL: Duration = Duration::from_millis(25);

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
    let mut guardian = Command::new(std::env::current_exe()?);
    guardian
        .process_group(0)
        .arg("--program-guardian")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: Only an async-signal-safe syscall runs before exec. The
    // guardian must ignore TERM even before it begins executing.
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

/// Runs independently of the host, which may have been killed before closing the pipe.
pub(crate) fn guard() -> io::Result<()> {
    let pid = std::process::id() as libc::pid_t;
    // SAFETY: getpgrp requires no arguments. Only signal the group we lead.
    if unsafe { libc::getpgrp() } != pid {
        return Err(io::Error::other("Program guardian must lead its group"));
    }
    let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
    // SAFETY: This is our dedicated group; the guardian ignores TERM.
    unsafe { libc::kill(-pid, libc::SIGTERM) };
    let deadline = Instant::now() + PROGRAM_TERM_GRACE;
    loop {
        if !group_has_programs(pid).unwrap_or(true) {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // SAFETY: The guardian is still alive and owns this group.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            return Ok(());
        }
        thread::sleep(remaining.min(GROUP_CHECK_INTERVAL));
    }
}

#[cfg(target_os = "linux")]
fn group_has_programs(group: libc::pid_t) -> io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        // SAFETY: getpgid looks up a PID; a process that exited no longer matches.
        if pid == group || unsafe { libc::getpgid(pid) } != group {
            continue;
        }
        // Zombies have already stopped. Anything we can't read might still be live.
        match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat)
                if stat.rsplit_once(") ").is_some_and(|(_, fields)| {
                    matches!(fields.as_bytes().first(), Some(b'Z' | b'X'))
                }) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => return Ok(true),
        }
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn group_has_programs(group: libc::pid_t) -> io::Result<bool> {
    let mut pids = [0; 64];
    // SAFETY: libproc writes at most the supplied buffer size.
    let listed = unsafe {
        libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), size_of_val(&pids) as i32)
    };
    if listed <= 0 {
        return Err(io::Error::last_os_error());
    }
    // A full buffer may have omitted live members.
    if pids.last().is_some_and(|&pid| pid > 0) {
        return Ok(true);
    }
    for pid in pids.into_iter().filter(|&pid| pid > 0 && pid != group) {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: info is a buffer of the exact size requested by PROC_PIDTBSDINFO.
        if unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        } == size
        {
            // SAFETY: libproc reported that it filled the entire structure.
            if unsafe { info.assume_init() }.pbi_status != libc::SZOMB {
                return Ok(true);
            }
        } else if unsafe { libc::getpgid(pid) } == group {
            return Ok(true);
        }
    }
    Ok(false)
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
