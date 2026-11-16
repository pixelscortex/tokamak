use super::*;
#[path = "procfs.rs"]
mod procfs;
use std::{
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
};

pub(crate) struct Guard {
    _cgroup: Cgroup,
    _procfs: procfs::Broker,
}
struct Cgroup(Option<PathBuf>);
impl Drop for Cgroup {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::write(path.join("cgroup.kill"), "1");
            let _ = std::fs::remove_dir(path);
        }
    }
}
#[repr(C)]
struct Ruleset {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}
#[repr(C, packed)]
struct PathRule {
    allowed_access: u64,
    parent_fd: i32,
}
const EXEC: u64 = 1;
const WRITE: u64 = 1 << 1;
const READ: u64 = (1 << 2) | (1 << 3);
const BASE: u64 = (1 << 13) - 1;
fn error() -> io::Error {
    io::Error::last_os_error()
}
fn cgroup(policy: &Policy) -> Result<(Cgroup, File), String> {
    // The server must be placed in a delegated cgroup with the controllers
    // enabled by its service manager. Never move the server or change its limits.
    let membership = std::fs::read_to_string("/proc/self/cgroup").map_err(|e| e.to_string())?;
    let relative = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or("No cgroup v2 membership")?;
    let parent = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
    // A delegated service usually keeps the server in a leaf subgroup, so its
    // workers must be siblings under the controller-enabled delegated parent.
    let parent = [Some(parent.as_path()), parent.parent()]
        .into_iter()
        .flatten()
        .find(|path| {
            std::fs::read_to_string(path.join("cgroup.subtree_control")).is_ok_and(|controllers| {
                ["memory", "cpu", "pids"]
                    .iter()
                    .all(|name| controllers.split_whitespace().any(|c| c == *name))
            })
        })
        .ok_or("No delegated parent with memory/cpu/pids controllers enabled")?;
    let path = parent.join(format!("tokamak-worker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).map_err(|e| e.to_string())?;
    let guard = Cgroup(Some(path.clone()));
    for (name, value) in [
        ("memory.max", policy.limits.memory_bytes.to_string()),
        ("pids.max", policy.limits.pids.to_string()),
        (
            "cpu.max",
            format!("{} 100000", policy.limits.cpu_percent * 1000),
        ),
    ] {
        std::fs::write(path.join(name), value).map_err(|e| format!("{name}: {e}"))?;
    }
    let procs = std::fs::OpenOptions::new()
        .write(true)
        .open(path.join("cgroup.procs"))
        .map_err(|e| e.to_string())?;
    Ok((guard, procs))
}
pub(super) fn apply(
    policy: &Policy,
    command: &mut tokio::process::Command,
) -> Result<Guard, String> {
    // Landlock syscall numbers are shared by Linux x86_64 and aarch64.
    let abi = unsafe { libc::syscall(444, std::ptr::null::<u8>(), 0, 1) };
    if abi < 1 {
        return Err(format!(
            "Landlock unavailable; refusing unconfined worker: {}",
            error()
        ));
    }
    if abi < 6 {
        logs::send(format!(
            "Worker sandbox: Landlock ABI {abi}; older kernels lack newer filesystem protections (REFER needs ABI 2, TRUNCATE ABI 3, device IOCTL ABI 5)"
        ));
    }
    let handled =
        BASE | if abi >= 2 {
            1 << 13
        } else {
            0
        } | if abi >= 3 {
            1 << 14
        } else {
            0
        } | if abi >= 5 {
            1 << 15
        } else {
            0
        };
    let attr = Ruleset {
        handled_access_fs: handled,
        handled_access_net: 0,
        scoped: if abi >= 6 {
            3
        } else {
            0
        },
    };
    let raw = unsafe {
        libc::syscall(
            444,
            &attr,
            if abi >= 6 {
                std::mem::size_of::<Ruleset>()
            } else {
                8
            },
            0,
        )
    };
    if raw < 0 {
        return Err(format!("Landlock create: {}", error()));
    }
    let ruleset = unsafe { OwnedFd::from_raw_fd(raw as i32) };
    for (paths, access) in [
        (&policy.read, READ),
        (&policy.write, handled & !EXEC),
        (&policy.exec, EXEC | (1 << 2)),
    ] {
        for path in paths {
            let cpath = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
                .map_err(|e| e.to_string())?;
            let raw = unsafe { libc::open(cpath.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
            if raw < 0 {
                return Err(format!("Sandbox open {}: {}", path.display(), error()));
            }
            let fd = unsafe { OwnedFd::from_raw_fd(raw) };
            let access = if path.is_dir() {
                access
            } else {
                access & (EXEC | WRITE | (1 << 2) | (1 << 14) | (1 << 15))
            };
            let rule = PathRule {
                allowed_access: access,
                parent_fd: fd.as_raw_fd(),
            };
            if unsafe { libc::syscall(445, ruleset.as_raw_fd(), 1, &rule, 0) } < 0 {
                return Err(format!("Landlock rule {}: {}", path.display(), error()));
            }
        }
    }
    // /dev/null is the only globally writable file; no directory authority.
    let null = File::open("/dev/null").map_err(|e| e.to_string())?;
    let rule = PathRule {
        allowed_access: WRITE,
        parent_fd: null.as_raw_fd(),
    };
    if unsafe { libc::syscall(445, ruleset.as_raw_fd(), 1, &rule, 0) } < 0 {
        return Err(format!("Landlock /dev/null: {}", error()));
    }
    let (guard, procs) = match cgroup(policy) {
        Ok((guard, fd)) => (guard, Some(fd)),
        Err(e) => {
            logs::send(format!(
                "Worker sandbox: delegated cgroup v2 unavailable ({e}); memory/CPU/pids limits not enforced"
            ));
            (Cgroup(None), None)
        }
    };
    let mut filter = filter(policy);
    let (sender, broker) = procfs::channel().map_err(|e| e.to_string())?;
    unsafe {
        command.pre_exec(move || {
            if let Some(fd) = &procs {
                if libc::write(fd.as_raw_fd(), b"0".as_ptr().cast(), 1) != 1 {
                    return Err(error());
                }
            }
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(error());
            }
            // /proc/self must refer to the child, never the host that prepared
            // the policy. Its descriptors are CLOEXEC and cannot expose host fds.
            let procfd = libc::open(c"/proc/self".as_ptr(), libc::O_PATH | libc::O_CLOEXEC);
            if procfd < 0 {
                return Err(error());
            }
            let own = PathRule {
                allowed_access: READ,
                parent_fd: procfd,
            };
            let added = libc::syscall(445, ruleset.as_raw_fd(), 1, &own, 0);
            libc::close(procfd);
            if added < 0 {
                return Err(error());
            }
            if libc::syscall(446, ruleset.as_raw_fd(), 0) < 0 {
                return Err(error());
            }
            let program = libc::sock_fprog {
                len: filter.len() as u16,
                filter: filter.as_mut_ptr(),
            };
            // NEW_LISTENER is inherited by descendants. Only the host owns the
            // listener; the pre-exec channel and local copy are CLOEXEC.
            let listener = libc::syscall(libc::SYS_seccomp, 1, 8, &program);
            if listener < 0 {
                return Err(error());
            }
            let sent = procfs::send(&sender, listener as i32);
            libc::close(listener as i32);
            sent?;
            Ok(())
        });
    }
    Ok(Guard {
        _cgroup: guard,
        _procfs: broker,
    })
}
fn filter(policy: &Policy) -> Vec<libc::sock_filter> {
    fn stmt(code: u16, k: u32) -> libc::sock_filter {
        libc::sock_filter {
            code,
            jt: 0,
            jf: 0,
            k,
        }
    }
    fn jump(k: u32, jt: u8, jf: u8) -> libc::sock_filter {
        libc::sock_filter {
            code: 0x15,
            jt,
            jf,
            k,
        }
    }
    // Validate architecture, including rejecting x32 syscalls on x86_64.
    #[cfg(target_arch = "x86_64")]
    let arch = 0xc000003e;
    #[cfg(target_arch = "aarch64")]
    let arch = 0xc00000b7;
    let mut bpf = vec![
        stmt(0x20, 4),
        jump(arch, 1, 0),
        stmt(0x06, 0x80000000),
        stmt(0x20, 0),
    ];
    #[cfg(target_arch = "x86_64")]
    bpf.extend([
        libc::sock_filter {
            code: 0x45,
            jt: 0,
            jf: 1,
            k: 0x40000000,
        },
        stmt(0x06, 0x80000000),
    ]);
    let mut deny = vec![
        libc::SYS_ptrace,
        libc::SYS_pidfd_getfd,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_bpf,
        libc::SYS_open_by_handle_at,
        libc::SYS_io_uring_setup,
    ];
    if !policy.network {
        deny.push(libc::SYS_socket);
        // Bun uses anonymous Unix stream socketpairs for child stdio. These
        // cannot connect to another peer. Reject datagram pairs, which could
        // sendto an outside Unix address, and all ordinary socket creation.
        bpf.extend([
            jump(libc::SYS_socketpair as u32, 0, 7),
            stmt(0x20, 16),
            jump(libc::AF_UNIX as u32, 0, 3),
            stmt(0x20, 24),
            stmt(0x54, 0xf),
            jump(libc::SOCK_STREAM as u32, 1, 0),
            stmt(0x06, 0x50000 | libc::EPERM as u32),
            stmt(0x20, 0),
        ]);
    }
    if !policy.processes {
        #[cfg(target_arch = "x86_64")]
        deny.extend([libc::SYS_fork, libc::SYS_vfork]);
        // clone3 has a pointer argument that classic BPF cannot inspect. Return
        // ENOSYS so libc falls back to clone, where threads remain permitted.
        bpf.extend([
            jump(libc::SYS_clone3 as u32, 0, 1),
            stmt(0x06, 0x50000 | libc::ENOSYS as u32),
        ]);
        bpf.extend([
            jump(libc::SYS_clone as u32, 0, 4),
            stmt(0x20, 16),
            libc::sock_filter {
                code: 0x45,
                jt: 1,
                jf: 0,
                k: libc::CLONE_THREAD as u32,
            },
            stmt(0x06, 0x50000 | libc::EPERM as u32),
            stmt(0x20, 0),
        ]);
    }
    for syscall in deny {
        bpf.extend([
            jump(syscall as u32, 0, 1),
            stmt(0x06, 0x50000 | libc::EPERM as u32),
        ]);
    }
    bpf.extend([jump(libc::SYS_openat as u32, 0, 1), stmt(0x06, 0x7fc00000)]);
    bpf.push(stmt(0x06, 0x7fff0000));
    bpf
}
