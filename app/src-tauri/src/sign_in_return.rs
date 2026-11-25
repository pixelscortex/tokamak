use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    net::{Ipv4Addr, Ipv6Addr, TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

const LIFETIME: Duration = Duration::from_secs(15 * 60);
const POLL: Duration = Duration::from_millis(20);
const REQUEST_LIMIT: Duration = Duration::from_secs(1);
const PAGE: &str = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Tokamak</title><p>Signed in. You can close this tab and go back to Tokamak.</p></html>";

#[derive(Default)]
pub struct Returns(Mutex<Active>);

#[derive(Default)]
struct Active {
    listeners: HashMap<u16, Listener>,
    // A close can reach the shell before the async listen command starts.
    early_cancels: VecDeque<(u16, String)>,
}

struct Listener {
    request_id: String,
    sockets: Vec<TcpListener>,
}

fn allowed_port(port: u16) -> bool {
    matches!(port, 54545 | 1455)
}

impl Returns {
    fn active(&self) -> MutexGuard<'_, Active> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn start(&self, port: u16, request_id: String) -> io::Result<bool> {
        let mut active = self.active();
        if let Some(index) = active
            .early_cancels
            .iter()
            .position(|(p, id)| *p == port && *id == request_id)
        {
            active.early_cancels.remove(index);
            return Ok(false);
        }
        active.listeners.remove(&port);
        let ipv4 = bind((Ipv4Addr::LOCALHOST, port).into())?;
        ipv4.set_nonblocking(true)?;
        let mut sockets = vec![ipv4];
        // Browsers may try ::1 first for localhost. An unavailable IPv6
        // stack is fine; an occupied IPv6 port is not ours to receive on.
        match bind((Ipv6Addr::LOCALHOST, port).into()) {
            Ok(ipv6) => {
                ipv6.set_nonblocking(true)?;
                sockets.push(ipv6);
            }
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::AddrNotAvailable | io::ErrorKind::Unsupported
                ) || matches!(err.raw_os_error(), Some(IPV6_NOT_SUPPORTED)) => {}
            Err(err) => return Err(err),
        }
        active.listeners.insert(
            port,
            Listener {
                request_id,
                sockets,
            },
        );
        Ok(true)
    }

    fn stop(&self, port: u16, request_id: String) {
        let mut active = self.active();
        if active
            .listeners
            .get(&port)
            .is_some_and(|entry| entry.request_id == request_id)
        {
            active.listeners.remove(&port);
            return;
        }
        // Retain only recent cancels, including ones for a return just delivered.
        if active.early_cancels.len() == 32 {
            active.early_cancels.pop_front();
        }
        active.early_cancels.push_back((port, request_id));
    }

    async fn wait(&self, port: u16, path: &str, request_id: &str, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        let mut request = None;
        loop {
            if let Some(result) = self.poll(port, path, request_id, deadline, &mut request) {
                return result;
            }
            tokio::time::sleep(POLL).await;
        }
    }

    fn poll(
        &self,
        port: u16,
        path: &str,
        request_id: &str,
        deadline: Instant,
        request: &mut Option<Request>,
    ) -> Option<Value> {
        let mut active = self.active();
        let Some(listener) = active
            .listeners
            .get(&port)
            .filter(|entry| entry.request_id == request_id)
        else {
            return Some(json!({ "status": "cancelled" }));
        };
        if Instant::now() >= deadline {
            active.listeners.remove(&port);
            return Some(json!({ "status": "expired" }));
        }
        if request.is_none() {
            *request = listener.sockets.iter().find_map(accept);
        }
        let incoming = request.as_mut()?;
        match incoming.poll(path) {
            RequestState::Matched(target) => {
                active.listeners.remove(&port);
                Some(json!({
                    "status": "returned",
                    "address": format!("http://localhost:{port}{target}")
                }))
            }
            RequestState::Done => {
                *request = None;
                None
            }
            RequestState::Waiting => None,
        }
    }
}

fn accept(socket: &TcpListener) -> Option<Request> {
    let (stream, _) = socket.accept().ok()?;
    stream.set_nonblocking(true).ok()?;
    Some(Request::new(stream))
}

fn bind(address: std::net::SocketAddr) -> io::Result<TcpListener> {
    let socket = if address.is_ipv4() {
        tokio::net::TcpSocket::new_v4()?
    } else {
        tokio::net::TcpSocket::new_v6()?
    };
    // On Unix, allow rearming after a completed HTTP connection is in TIME_WAIT.
    // On Windows SO_REUSEADDR can let two processes bind the same address.
    #[cfg(unix)]
    socket.set_reuseaddr(true)?;
    socket.bind(address)?;
    socket.listen(16)?.into_std()
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const IPV6_NOT_SUPPORTED: i32 = 47;
#[cfg(target_os = "windows")]
const IPV6_NOT_SUPPORTED: i32 = 10047;
#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
const IPV6_NOT_SUPPORTED: i32 = 97;

enum RequestState {
    Waiting,
    Done,
    Matched(String),
}

struct Request {
    stream: TcpStream,
    bytes: Vec<u8>,
    deadline: Instant,
}

impl Request {
    fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            bytes: Vec::new(),
            deadline: Instant::now() + REQUEST_LIMIT,
        }
    }

    fn poll(&mut self, path: &str) -> RequestState {
        if Instant::now() >= self.deadline {
            return RequestState::Done;
        }
        let mut buf = [0; 2048];
        match self.stream.read(&mut buf) {
            Ok(0) => return RequestState::Done,
            Ok(n) => self.bytes.extend_from_slice(&buf[..n]),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => return RequestState::Waiting,
            Err(_) => return RequestState::Done,
        }
        if self.bytes.len() > 8192 {
            return RequestState::Done;
        }
        // Drain the headers before replying so the browser sees a clean close.
        if !self.bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            return RequestState::Waiting;
        }
        let target = self
            .bytes
            .split(|&byte| byte == b'\r')
            .next()
            .and_then(|line| std::str::from_utf8(line).ok())
            .and_then(|line| matching_target(line, path));
        let (status, body) = if target.is_some() {
            ("200 OK", PAGE)
        } else {
            ("404 Not Found", "")
        };
        let _ = write!(
            self.stream,
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        target.map_or(RequestState::Done, |target| {
            RequestState::Matched(target.to_owned())
        })
    }
}

fn matching_target<'a>(line: &'a str, path: &str) -> Option<&'a str> {
    let mut parts = line.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let version = parts.next()?;
    let request_path = target.split_once('?').map_or(target, |(path, _)| path);
    (matches!(version, "HTTP/1.0" | "HTTP/1.1")
        && parts.next().is_none()
        && !target.contains(['#', '\\'])
        && !target.bytes().any(|byte| byte.is_ascii_control())
        && request_path.starts_with(path))
    .then_some(target)
}

#[tauri::command]
pub async fn sign_in_return_listen(
    returns: tauri::State<'_, Returns>,
    port: u16,
    path: String,
    request_id: String,
    timeout_ms: u64,
) -> Result<Value, &'static str> {
    if !allowed_port(port) {
        return Err("Unsupported sign-in return port");
    }
    if !valid_request_id(&request_id) {
        return Err("Invalid sign-in return request id");
    }
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['?', '#', '\\']) {
        return Err("Invalid sign-in return path");
    }
    let timeout = Duration::from_millis(timeout_ms).min(LIFETIME);
    if timeout.is_zero() {
        return Ok(json!({ "status": "expired" }));
    }
    match returns.start(port, request_id.clone()) {
        Ok(true) => {}
        Ok(false) => return Ok(json!({ "status": "cancelled" })),
        Err(err) if err.kind() == io::ErrorKind::AddrInUse => {
            return Ok(json!({ "status": "busy" }));
        }
        Err(_) => return Err("Could not listen for sign-in"),
    }
    Ok(returns.wait(port, &path, &request_id, timeout).await)
}

#[tauri::command]
pub fn sign_in_return_cancel(returns: tauri::State<'_, Returns>, port: u16, request_id: String) {
    if allowed_port(port) && valid_request_id(&request_id) {
        returns.stop(port, request_id);
    }
}

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty() && request_id.len() <= 64
}

#[tauri::command]
pub async fn sign_in_open_browser(url: String) -> Result<(), &'static str> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid sign-in URL")?;
    if !url.starts_with("https://") || parsed.scheme() != "https" || !parsed.has_host() {
        return Err("Sign-in URLs must use HTTPS");
    }
    tauri::async_runtime::spawn_blocking(move || open_browser(parsed.as_str()))
        .await
        .map_err(|_| "Could not open the browser")?
}

fn open_browser(url: &str) -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    let (program, args) = ("open", &["--", url][..]);
    #[cfg(target_os = "linux")]
    let (program, args) = ("xdg-open", &[url][..]);
    // Explorer hands HTTPS URLs to the registered handler without cmd.exe.
    #[cfg(target_os = "windows")]
    let (program, args) = ("explorer.exe", &[url][..]);

    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Could not open the browser")?;
    // Explorer can delegate to an existing process and exit with code 1.
    if status.success() || (cfg!(target_os = "windows") && status.code() == Some(1)) {
        Ok(())
    } else {
        Err("Could not open the browser")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn available_port() -> u16 {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn get(address: impl std::net::ToSocketAddrs, target: &str) -> String {
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(stream, "GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    }

    #[test]
    fn offers_only_the_provider_ports() {
        assert!(allowed_port(54545));
        assert!(allowed_port(1455));
        assert!(!allowed_port(0));
        assert!(!allowed_port(54546));
    }

    #[test]
    fn accepts_one_matching_request_on_loopback_and_can_rearm() {
        tauri::async_runtime::block_on(async {
            let returns = Arc::new(Returns::default());
            let port = available_port();
            returns.start(port, "one".into()).unwrap();
            let addresses: Vec<_> = returns.active().listeners[&port]
                .sockets
                .iter()
                .map(|socket| socket.local_addr().unwrap())
                .collect();
            assert_eq!(addresses[0].ip(), Ipv4Addr::LOCALHOST);
            assert!(addresses.iter().all(|address| address.ip().is_loopback()));

            let waiting = Arc::clone(&returns);
            let task = tauri::async_runtime::spawn(async move {
                waiting
                    .wait(port, "/callback", "one", Duration::from_secs(5))
                    .await
            });
            let response = tauri::async_runtime::spawn_blocking(move || {
                assert!(
                    get(addresses[0], "/favicon.ico?next=/callback").starts_with("HTTP/1.1 404")
                );
                // Exercise ::1 when the platform supports it. Browsers can prefer it.
                get(
                    *addresses.last().unwrap(),
                    "/callback?code=synthetic&state=test",
                )
            })
            .await
            .unwrap();
            assert!(response.starts_with("HTTP/1.1 200"));
            assert!(response.contains("You can close this tab"));
            assert!(!response.contains("synthetic"));
            assert_eq!(
                task.await.unwrap(),
                json!({
                    "status": "returned",
                    "address": format!("http://localhost:{port}/callback?code=synthetic&state=test"),
                })
            );
            assert!(!returns.active().listeners.contains_key(&port));
            #[cfg(unix)]
            returns.start(port, "retry".into()).unwrap();
        });
    }

    #[test]
    fn busy_replacement_cancel_and_timeout_release_the_port() {
        tauri::async_runtime::block_on(async {
            let returns = Returns::default();
            let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = occupied.local_addr().unwrap().port();
            assert_eq!(
                returns.start(port, "one".into()).unwrap_err().kind(),
                io::ErrorKind::AddrInUse
            );
            drop(occupied);

            returns.start(port, "one".into()).unwrap();
            returns.start(port, "two".into()).unwrap();
            returns.stop(port, "never-started".into());
            assert!(!returns.start(port, "never-started".into()).unwrap());
            // Cleanup from an older dialog must never cancel a newer one.
            returns.stop(port, "one".into());
            let timeout = Duration::from_millis(35);
            assert_eq!(
                returns.wait(port, "/callback", "one", timeout).await["status"],
                "cancelled"
            );
            assert_eq!(
                returns.wait(port, "/callback", "two", timeout).await["status"],
                "expired"
            );
            returns.start(port, "three".into()).unwrap();
            returns.stop(port, "three".into());
            assert_eq!(
                returns.wait(port, "/callback", "three", timeout).await["status"],
                "cancelled"
            );
            assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
        });
    }
}
