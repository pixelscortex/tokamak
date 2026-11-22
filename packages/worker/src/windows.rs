use super::Lane;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io,
    marker::PhantomData,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null, null_mut},
};
use tokio::{
    process::{ChildStderr, ChildStdin, ChildStdout},
    task::{JoinHandle, spawn_blocking},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0},
    System::{JobObjects::*, Threading::*},
};

pub(super) struct Child {
    pub(super) stdin: Option<ChildStdin>,
    pub(super) stdout: Option<ChildStdout>,
    pub(super) stderr: Option<ChildStderr>,
    exit: Option<JoinHandle<io::Result<u32>>>,
}

impl Child {
    pub(super) async fn wait(&mut self) -> io::Result<Option<u32>> {
        let Some(exit) = &mut self.exit else {
            return Ok(None);
        };
        let status = exit.await;
        self.exit = None;
        status?.map(Some)
    }
}

pub(super) fn spawn(
    bun: &Path,
    entry: &Path,
    code: &Path,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    lane: Lane,
) -> io::Result<(Child, OwnedHandle)> {
    let (input, stdin) = io::pipe()?;
    let (stdout, output) = io::pipe()?;
    let (stderr, errors) = io::pipe()?;
    let stdin = ChildStdin::from_std(std::process::ChildStdin::from(OwnedHandle::from(stdin)))?;
    let stdout = ChildStdout::from_std(std::process::ChildStdout::from(OwnedHandle::from(stdout)))?;
    let stderr = ChildStderr::from_std(std::process::ChildStderr::from(OwnedHandle::from(stderr)))?;

    let job = create_job()?;
    let pipes = [
        input.as_raw_handle(),
        output.as_raw_handle(),
        errors.as_raw_handle(),
    ];
    let handle = create_process(bun, [entry, code], cwd, env, &job, pipes, lane)?;
    let exit = spawn_blocking(move || {
        // SAFETY: The process handle is owned by this wait until it completes.
        unsafe {
            check(WaitForSingleObject(handle.as_raw_handle(), INFINITE) == WAIT_OBJECT_0)?;
            let mut status = 0;
            check(GetExitCodeProcess(handle.as_raw_handle(), &mut status) != 0)?;
            Ok(status)
        }
    });
    Ok((
        Child {
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr: Some(stderr),
            exit: Some(exit),
        },
        job,
    ))
}

fn create_job() -> io::Result<OwnedHandle> {
    // SAFETY: The job is unnamed and non-inheritable; a successful call returns a new handle.
    unsafe {
        let raw = CreateJobObjectW(null(), null());
        check(!raw.is_null())?;
        let job = OwnedHandle::from_raw_handle(raw);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(
            SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of_val(&limits) as u32,
            ) != 0,
        )?;
        Ok(job)
    }
}

fn create_process(
    bun: &Path,
    [entry, code]: [&Path; 2],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    job: &OwnedHandle,
    pipes: [HANDLE; 3],
    lane: Lane,
) -> io::Result<OwnedHandle> {
    let application = wide(bun.as_os_str())?;
    let directory = wide(std::path::absolute(cwd)?.as_os_str())?;
    let mut command = OsString::new();
    for path in [bun, entry, code] {
        // These are file paths, so none can end in a backslash or contain quotes.
        command.push("\"");
        command.push(path);
        command.push("\" ");
    }
    let mut command = wide(&command)?;
    let environment = environment_block(env, lane)?;
    let job_list = [job.as_raw_handle()];
    let mut attributes = Attributes::new()?;
    attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job_list)?;
    attributes.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &pipes)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of_val(&startup) as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    [
        startup.StartupInfo.hStdInput,
        startup.StartupInfo.hStdOutput,
        startup.StartupInfo.hStdError,
    ] = pipes;
    startup.lpAttributeList = attributes.as_ptr();
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: The UTF-16 buffers, attribute values and their handles stay valid
    // through CreateProcessW, which fills `process` only on success.
    unsafe {
        for pipe in pipes {
            check(SetHandleInformation(pipe, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0)?;
        }
        // JOB_LIST assigns the job as part of CreateProcessW (Windows 10+),
        // before any worker code can run. There is no uncontained process even
        // if the server dies during startup. Neither breakaway flag is enabled.
        check(
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment.as_ptr().cast(),
                directory.as_ptr(),
                (&raw const startup).cast(),
                &mut process,
            ) != 0,
        )?;
        drop(OwnedHandle::from_raw_handle(process.hThread));
        Ok(OwnedHandle::from_raw_handle(process.hProcess))
    }
}

fn environment_block(env: &BTreeMap<String, String>, lane: Lane) -> io::Result<Vec<u16>> {
    // Windows expects case-insensitively sorted entries and a double NUL.
    let sorted: BTreeMap<_, _> = env
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .chain([lane.env()])
        .map(|(name, value)| (name.to_ascii_uppercase(), (name, value)))
        .collect();
    let mut environment = Vec::new();
    for (name, value) in sorted.values() {
        if name.is_empty() || name.contains('=') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid environment key",
            ));
        }
        environment.extend(wide(OsStr::new(&format!("{name}={value}")))?);
    }
    environment.resize(environment.len().max(1) + 1, 0);
    Ok(environment)
}

fn check(success: bool) -> io::Result<()> {
    if success {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut units: Vec<_> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unexpected NUL",
        ));
    }
    units.push(0);
    Ok(units)
}

struct Attributes<'a> {
    storage: Vec<usize>,
    handles: PhantomData<&'a [HANDLE]>,
}

impl<'a> Attributes<'a> {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: A null list asks Windows for the required allocation size.
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        // SAFETY: The backing heap allocation has the requested size and pointer alignment.
        check(
            unsafe {
                InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
            } != 0,
        )?;
        Ok(Self {
            storage,
            handles: PhantomData,
        })
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }

    fn add(&mut self, kind: u32, handles: &'a [HANDLE]) -> io::Result<()> {
        // SAFETY: The list was initialized and the borrowed values outlive it.
        check(
            unsafe {
                UpdateProcThreadAttribute(
                    self.as_ptr(),
                    0,
                    kind as usize,
                    handles.as_ptr().cast(),
                    size_of_val(handles),
                    null_mut(),
                    null(),
                )
            } != 0,
        )
    }
}

impl Drop for Attributes<'_> {
    fn drop(&mut self) {
        // SAFETY: Only an initialized list reaches Drop, with its storage still live.
        unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
    }
}
