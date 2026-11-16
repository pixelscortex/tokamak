//! Landlock rules name inodes: /proc/self in the launcher would name only that
//! process, not future children. A narrow seccomp broker supplies read-only
//! runtime accounting files for the *calling* task, without exposing /proc for
//! other processes. All other opens continue through normal Landlock checks.
use std::{
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
#[repr(C)]
#[derive(Default)]
struct Data {
    nr: i32,
    arch: u32,
    ip: u64,
    args: [u64; 6],
}
#[repr(C)]
#[derive(Default)]
struct Notification {
    id: u64,
    pid: u32,
    flags: u32,
    data: Data,
}
#[repr(C)]
struct Response {
    id: u64,
    val: i64,
    error: i32,
    flags: u32,
}
#[repr(C)]
struct AddFd {
    id: u64,
    flags: u32,
    srcfd: u32,
    newfd: u32,
    newfd_flags: u32,
}
const RECV: libc::c_ulong = 0xc0502100;
const SEND: libc::c_ulong = 0xc0182101;
const ADD_FD: libc::c_ulong = 0x40182103;

pub(super) struct Broker {
    stop: Arc<AtomicBool>,
    socket: UnixStream,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
pub(super) fn channel() -> io::Result<(UnixStream, Broker)> {
    let (sender, receiver) = UnixStream::pair()?;
    let socket = receiver.try_clone()?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let thread = std::thread::Builder::new()
        .name("worker-procfs".into())
        .spawn(move || {
            if let Ok(listener) = receive(&receiver) {
                serve(listener, &stopping);
            }
        })?;
    Ok((
        sender,
        Broker {
            stop,
            socket,
            thread: Some(thread),
        },
    ))
}
// Ancillary buffers need native word alignment. These functions run before exec
// (send) or in the host broker (receive), never in plugin JavaScript.
pub(super) fn send(socket: &UnixStream, fd: i32) -> io::Result<()> {
    let mut byte = 0u8;
    let mut vector = libc::iovec {
        iov_base: (&mut byte as *mut u8).cast(),
        iov_len: 1,
    };
    let mut control = [0usize; 4];
    unsafe {
        let mut message: libc::msghdr = std::mem::zeroed();
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = libc::CMSG_SPACE(4) as usize;
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(4) as usize;
        std::ptr::write(libc::CMSG_DATA(header).cast::<i32>(), fd);
        if libc::sendmsg(socket.as_raw_fd(), &message, libc::MSG_NOSIGNAL) != 1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
fn receive(socket: &UnixStream) -> io::Result<OwnedFd> {
    let mut byte = 0u8;
    let mut vector = libc::iovec {
        iov_base: (&mut byte as *mut u8).cast(),
        iov_len: 1,
    };
    let mut control = [0usize; 4];
    unsafe {
        let mut message: libc::msghdr = std::mem::zeroed();
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control);
        if libc::recvmsg(socket.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) != 1 {
            return Err(io::Error::last_os_error());
        }
        let header = libc::CMSG_FIRSTHDR(&message);
        if header.is_null()
            || (*header).cmsg_level != libc::SOL_SOCKET
            || (*header).cmsg_type != libc::SCM_RIGHTS
            || (*header).cmsg_len != libc::CMSG_LEN(4) as usize
        {
            return Err(io::Error::other("Invalid worker seccomp listener"));
        }
        Ok(OwnedFd::from_raw_fd(std::ptr::read(
            libc::CMSG_DATA(header).cast::<i32>(),
        )))
    }
}
fn path(pid: u32, pointer: u64) -> Option<String> {
    let mut bytes = [0u8; 4096];
    let mut count = 0;
    while count < bytes.len() {
        let address = pointer.checked_add(count as u64)? as usize;
        let length = (4096 - address % 4096).min(bytes.len() - count);
        let local = libc::iovec {
            iov_base: bytes[count..].as_mut_ptr().cast(),
            iov_len: length,
        };
        let remote = libc::iovec {
            iov_base: address as *mut libc::c_void,
            iov_len: length,
        };
        let read = unsafe { libc::process_vm_readv(pid as i32, &local, 1, &remote, 1, 0) };
        if read <= 0 {
            return None;
        }
        count += read as usize;
        if let Some(end) = bytes[..count].iter().position(|b| *b == 0) {
            return std::str::from_utf8(&bytes[..end]).ok().map(str::to_owned);
        }
    }
    None
}
fn accounting(request: &Notification) -> Option<String> {
    let path = path(request.pid, request.data.args[1])?;
    let file = path.strip_prefix("/proc/self/")?;
    if !["maps", "stat", "statm", "status", "auxv", "cgroup"].contains(&file) {
        return None;
    }
    let flags = request.data.args[2] as i32;
    if flags & (libc::O_ACCMODE | libc::O_CREAT | libc::O_TRUNC | libc::O_APPEND | libc::O_PATH)
        != libc::O_RDONLY
    {
        return None;
    }
    Some(format!("/proc/{}/{file}", request.pid))
}
fn serve(listener: OwnedFd, stop: &AtomicBool) {
    let fd = listener.as_raw_fd();
    while !stop.load(Ordering::Acquire) {
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if ready < 0 || poll.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            return;
        }
        if ready == 0 {
            continue;
        }
        let mut request = Notification::default();
        if unsafe { libc::ioctl(fd, RECV, &mut request) } < 0 {
            continue;
        }
        let mut response = Response {
            id: request.id,
            val: 0,
            error: 0,
            flags: 1,
        }; // CONTINUE
        if let Some(path) = accounting(&request) {
            match File::open(path) {
                Ok(file) => {
                    // SEND atomically validates the notification ID, inserts the
                    // FD and resumes this syscall; PID reuse cannot leak a file.
                    let mut add = AddFd {
                        id: request.id,
                        flags: 2,
                        srcfd: file.as_raw_fd() as u32,
                        newfd: 0,
                        newfd_flags: request.data.args[2] as u32 & libc::O_CLOEXEC as u32,
                    };
                    if unsafe { libc::ioctl(fd, ADD_FD, &add) } >= 0 {
                        continue;
                    }
                    // Linux 5.13 has Landlock but predates ADDFD_FLAG_SEND.
                    // Both separate ioctls still validate the notification ID;
                    // an interrupted task can only retain its own proc FD.
                    if io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
                        add.flags = 0;
                        let target = unsafe { libc::ioctl(fd, ADD_FD, &add) };
                        if target >= 0 {
                            response.flags = 0;
                            response.val = i64::from(target);
                            let _ = unsafe { libc::ioctl(fd, SEND, &response) };
                            continue;
                        }
                    }
                    response.flags = 0;
                    response.error = -libc::EACCES;
                }
                Err(error) => {
                    response.flags = 0;
                    response.error = -error.raw_os_error().unwrap_or(libc::EACCES);
                }
            }
        }
        let _ = unsafe { libc::ioctl(fd, SEND, &response) };
    }
}
