use std::{io, os::unix::process::CommandExt, process::Command};

/// Keep stdio and, if requested, one extra descriptor across exec.
///
/// This runs in the child after fork, so it also covers descriptors opened by
/// other threads before fork but not yet marked CLOEXEC. Mark rather than close
/// them so Command can still use its private pipe to report an exec error.
pub fn inherit_only(command: &mut Command, keep: Option<i32>) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let bound = descriptor_bound()?;
    // SAFETY: The child only uses async-signal-safe syscalls, without locks or
    // allocation. Command sets up stdio before running this callback.
    unsafe {
        command.pre_exec(move || {
            #[cfg(target_os = "linux")]
            if libc::syscall(
                libc::SYS_close_range,
                3_u32,
                u32::MAX,
                libc::CLOSE_RANGE_CLOEXEC,
            ) != 0
            {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.raw_os_error(),
                    Some(libc::ENOSYS | libc::EINVAL | libc::EPERM)
                ) {
                    return Err(error);
                }
                mark_proc_descriptors()?;
            }
            #[cfg(target_os = "macos")]
            for fd in 3..bound {
                mark_descriptor(fd)?;
            }
            if let Some(fd) = keep
                && libc::fcntl(fd, libc::F_SETFD, 0) < 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

fn mark_descriptor(fd: i32) -> io::Result<()> {
    // SAFETY: fcntl takes an integer flag for F_SETFD.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EBADF) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn mark_proc_descriptors() -> io::Result<()> {
    // Kernels before 5.11 (and some seccomp profiles) lack CLOSE_RANGE_CLOEXEC.
    // The forked child has a private table. Use raw getdents64 and a stack
    // buffer so no libc directory iterator, allocator or lock is involved.
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // SAFETY: The path is NUL terminated, and open does not create a file.
    let directory = unsafe {
        libc::open(
            c"/proc/self/fd".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if directory < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: open returned a fresh descriptor.
    let directory = unsafe { OwnedFd::from_raw_fd(directory) };
    let mut buffer = [0_u8; 4096];
    loop {
        // SAFETY: The kernel writes at most buffer.len() bytes into buffer.
        let count = unsafe {
            libc::syscall(
                libc::SYS_getdents64,
                directory.as_raw_fd(),
                buffer.as_mut_ptr(),
                buffer.len(),
            )
        };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count == 0 {
            return Ok(());
        }
        let mut entries = &buffer[..count as usize];
        while !entries.is_empty() {
            // linux_dirent64: inode (8), offset (8), record length (2), type (1), name.
            let length = u16::from_ne_bytes([entries[16], entries[17]]) as usize;
            let name = entries[19..length]
                .split(|byte| *byte == 0)
                .next()
                .unwrap_or_default();
            if let Ok(name) = std::str::from_utf8(name)
                && let Ok(fd) = name.parse::<i32>()
                && fd >= 3
            {
                mark_descriptor(fd)?;
            }
            entries = &entries[length..];
        }
    }
}

#[cfg(target_os = "macos")]
fn descriptor_bound() -> io::Result<i32> {
    // XNU clamps every new descriptor to kern.maxfilesperproc, even if
    // RLIMIT_NOFILE is unlimited. The table size covers descriptors that were
    // already open when a limit was lowered. Both queries run before fork.
    let mut limit = 0_i32;
    let mut size = std::mem::size_of_val(&limit);
    // SAFETY: The output value and its length are writable for the syscall.
    if unsafe {
        libc::sysctlbyname(
            c"kern.maxfilesperproc".as_ptr(),
            (&raw mut limit).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: The buffer is writable for size bytes. A complete result
    // initializes the struct, including XNU's descriptor table size.
    let received = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if received != size {
        return Err(io::Error::last_os_error());
    }
    let table_size = unsafe { info.assume_init() }.pbi_nfiles;
    Ok(limit.max(i32::try_from(table_size).map_err(io::Error::other)?))
}

#[cfg(test)]
mod tests {
    use std::{
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        os::unix::net::UnixDatagram,
    };
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn worker_inherits_its_control_socket_only() {
        const FDS: &str = "TOKAMAK_TEST_SPAWN_FDS";
        if let Ok(fds) = std::env::var(FDS) {
            let (extra, control) = fds.split_once(',').unwrap();
            let extra = extra.parse::<i32>().unwrap();
            let control = control.parse::<i32>().unwrap();
            assert_eq!(unsafe { libc::fcntl(extra, libc::F_GETFD) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EBADF)
            );
            assert_eq!(unsafe { libc::fcntl(control, libc::F_GETFD) }, 0);
            let control = unsafe { UnixDatagram::from_raw_fd(control) };
            control.send(b"child").unwrap();
            return;
        }
        let (parent, socket) = UnixDatagram::pair().unwrap();
        // Use high descriptors to distinguish inheritance from an fd reused by
        // the child test harness. F_DUPFD deliberately leaves CLOEXEC off.
        let duplicate = |flags| {
            let fd = unsafe { libc::fcntl(socket.as_raw_fd(), flags, 128) };
            assert!(fd >= 128);
            unsafe { OwnedFd::from_raw_fd(fd) }
        };
        let extra = duplicate(libc::F_DUPFD);
        let control = duplicate(libc::F_DUPFD_CLOEXEC);
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "spawn::tests::worker_inherits_its_control_socket_only",
            ])
            .env(
                FDS,
                format!("{},{}", extra.as_raw_fd(), control.as_raw_fd()),
            );
        let (mut child, _group, _guardian) =
            crate::spawn_group(command, Some(control.as_raw_fd())).unwrap();
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut output)
            .await
            .unwrap();
        assert!(
            child.wait().await.unwrap().success(),
            "{}",
            String::from_utf8_lossy(&output)
        );
        parent.set_nonblocking(true).unwrap();
        let mut message = [0; 5];
        assert_eq!(parent.recv(&mut message).unwrap(), 5);
        assert_eq!(&message, b"child");
        assert_eq!(
            unsafe { libc::fcntl(extra.as_raw_fd(), libc::F_GETFD) },
            0,
            "the parent keeps its socket"
        );
    }
}
