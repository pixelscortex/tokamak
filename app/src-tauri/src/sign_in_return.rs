use std::{
    collections::{HashMap, VecDeque},
    io,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    process::{Command, Stdio},
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    sync::{Mutex as AsyncMutex, oneshot},
    time::timeout,
};

const LIFETIME: Duration = Duration::from_secs(15 * 60);
const REQUEST_LIMIT: Duration = Duration::from_secs(1);
const HEADER_LIMIT: usize = 8192;
const PAGE: &str = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Tokamak</title><p>Signed in. You can close this tab and go back to Tokamak.</p></html>";

#[derive(Default)]
pub struct Returns {
    active: Mutex<Active>,
    // Wait for the previous listener to drop its sockets before rebinding.
    claude: AsyncMutex<()>,
    openai: AsyncMutex<()>,
}

#[derive(Default)]
struct Active {
    listeners: HashMap<u16, Listener>,
    // A close can reach the shell before the async listen command starts.
    early_cancels: VecDeque<(u16, String)>,
}

struct Listener {
    request_id: String,
    // Dropping the sender wakes the command on cancellation or replacement.
    _cancel: oneshot::Sender<()>,
}

fn allowed_port(port: u16) -> bool {
    matches!(port, 54545 | 1455)
}

impl Returns {
    fn active(&self) -> MutexGuard<'_, Active> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn register(&self, port: u16, request_id: &str) -> Option<oneshot::Receiver<()>> {
        let mut active = self.active();
        if let Some(index) = active
            .early_cancels
            .iter()
            .position(|(p, id)| *p == port && id == request_id)
        {
            active.early_cancels.remove(index);
            return None;
        }
        let (cancel, cancelled) = oneshot::channel();
        active.listeners.insert(
            port,
            Listener {
                request_id: request_id.into(),
                _cancel: cancel,
            },
        );
        Some(cancelled)
    }

    fn stop(&self, port: u16, request_id: String) {
        let mut active = self.active();
        if remove_matching(&mut active, port, &request_id) {
            return;
        }
        if active.early_cancels.len() == 32 {
            active.early_cancels.pop_front();
        }
        active.early_cancels.push_back((port, request_id));
    }

    async fn listen(
        &self,
        port: u16,
        path: &str,
        expected_state: &str,
        request_id: &str,
        lifetime: Duration,
    ) -> Result<Value, &'static str> {
        let Some(cancelled) = self.register(port, request_id) else {
            return Ok(json!({ "status": "cancelled" }));
        };
        let lease = if port == 1455 {
            &self.openai
        } else {
            &self.claude
        };
        let result = tokio::select! {
            biased;
            _ = cancelled => Ok(json!({ "status": "cancelled" })),
            result = timeout(lifetime, async {
                let _lease = lease.lock().await;
                listen_once(port, path, expected_state).await
            }) => result.unwrap_or_else(|_| Ok(json!({ "status": "expired" }))),
        };
        remove_matching(&mut self.active(), port, request_id);
        result
    }
}

fn remove_matching(active: &mut Active, port: u16, request_id: &str) -> bool {
    let std::collections::hash_map::Entry::Occupied(entry) = active.listeners.entry(port) else {
        return false;
    };
    if entry.get().request_id != request_id {
        return false;
    }
    entry.remove();
    true
}

fn bind(address: SocketAddr) -> io::Result<TcpListener> {
    let socket = if address.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    // Use a fresh socket without SO_REUSEADDR. In particular, on macOS a
    // specific address with reuse can steal traffic from a wildcard listener.
    socket.bind(address)?;
    socket.listen(16)
}

fn bind_loopback(port: u16) -> io::Result<(TcpListener, Option<TcpListener>)> {
    let ipv4 = bind((Ipv4Addr::LOCALHOST, port).into())?;
    let ipv6 = match bind((Ipv6Addr::LOCALHOST, port).into()) {
        Ok(socket) => Some(socket),
        Err(err) if ipv6_unavailable(&err) => None,
        Err(err) => return Err(err),
    };
    Ok((ipv4, ipv6))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
const IPV6_NOT_SUPPORTED: i32 = 47;
#[cfg(target_os = "windows")]
const IPV6_NOT_SUPPORTED: i32 = 10047;
#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
const IPV6_NOT_SUPPORTED: i32 = 97;

fn ipv6_unavailable(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::AddrNotAvailable | io::ErrorKind::Unsupported
    ) || err.raw_os_error() == Some(IPV6_NOT_SUPPORTED)
}

async fn accept(ipv4: &TcpListener, ipv6: Option<&TcpListener>) -> io::Result<TcpStream> {
    let connection = match ipv6 {
        Some(ipv6) => tokio::select! {
            connection = ipv4.accept() => connection,
            connection = ipv6.accept() => connection,
        },
        None => ipv4.accept().await,
    }?;
    Ok(connection.0)
}

async fn listen_once(port: u16, path: &str, state: &str) -> Result<Value, &'static str> {
    let (ipv4, ipv6) = match bind_loopback(port) {
        Ok(sockets) => sockets,
        Err(err) if err.kind() == io::ErrorKind::AddrInUse => {
            return Ok(json!({ "status": "busy" }));
        }
        Err(_) => return Err("Could not listen for sign-in"),
    };
    let (mut stream, target) = receive(&ipv4, ipv6.as_ref(), path, state)
        .await
        .map_err(|_| "Could not accept sign-in return")?;
    drop((ipv4, ipv6));
    reply(&mut stream, true).await;
    Ok(json!({ "status": "returned", "address": format!("http://localhost:{port}{target}") }))
}

async fn receive(
    ipv4: &TcpListener,
    ipv6: Option<&TcpListener>,
    path: &str,
    state: &str,
) -> io::Result<(TcpStream, String)> {
    loop {
        let mut stream = accept(ipv4, ipv6).await?;
        let Ok(Ok(line)) = timeout(REQUEST_LIMIT, request_line(&mut stream)).await else {
            continue;
        };
        if let Some(target) = matching_target(&line, path, state) {
            return Ok((stream, target.to_owned()));
        }
        reply(&mut stream, false).await;
    }
}

async fn request_line(stream: &mut TcpStream) -> io::Result<String> {
    let mut bytes = [0; HEADER_LIMIT];
    let mut len = 0;
    while len < bytes.len() {
        let size = stream.read(&mut bytes[len..]).await?;
        if size == 0 {
            break;
        }
        let start = len.saturating_sub(3);
        len += size;
        if bytes[start..len].windows(4).any(|part| part == b"\r\n\r\n") {
            let line = bytes[..len]
                .split(|&byte| byte == b'\r')
                .next()
                .unwrap_or_default();
            return String::from_utf8(line.to_vec()).map_err(io::Error::other);
        }
    }
    Err(io::Error::other("Incomplete or oversized HTTP headers"))
}

async fn reply(stream: &mut TcpStream, matched: bool) {
    let (status, body) = if matched {
        ("200 OK", PAGE)
    } else {
        ("404 Not Found", "")
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = timeout(REQUEST_LIMIT, async {
        stream.write_all(response.as_bytes()).await?;
        // Let the browser close first so the local port can be reused without SO_REUSEADDR.
        tokio::io::copy(stream, &mut tokio::io::sink()).await
    })
    .await;
}

fn matching_target<'a>(line: &'a str, path: &str, state: &str) -> Option<&'a str> {
    let mut parts = line.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let version = parts.next()?;
    let (request_path, query) = target.split_once('?')?;
    if request_path != path
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || parts.next().is_some()
        || target.contains(['#', '\\'])
        || target.bytes().any(|byte| byte.is_ascii_control())
    {
        return None;
    }
    let url = tauri::Url::parse(&format!("http://localhost/?{query}")).ok()?;
    let mut states = url.query_pairs().filter(|(key, _)| key == "state");
    (states.next().is_some_and(|(_, value)| value == state) && states.next().is_none())
        .then_some(target)
}

fn valid_path(path: &str) -> bool {
    path.len() > 1
        && path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains(['?', '#', '\\'])
        && !path.bytes().any(|byte| byte.is_ascii_control())
        && tauri::Url::parse(&format!("http://localhost{path}")).is_ok_and(|url| url.path() == path)
}

#[tauri::command]
pub async fn sign_in_return_listen(
    returns: tauri::State<'_, Returns>,
    port: u16,
    path: String,
    expected_state: String,
    request_id: String,
    timeout_ms: u64,
) -> Result<Value, &'static str> {
    if !allowed_port(port) {
        return Err("Unsupported sign-in return port");
    }
    if !valid_request_id(&request_id) {
        return Err("Invalid sign-in return request id");
    }
    if !valid_path(&path) {
        return Err("Invalid sign-in return path");
    }
    if expected_state.is_empty() || expected_state.len() > HEADER_LIMIT {
        return Err("Invalid sign-in return state");
    }
    let lifetime = Duration::from_millis(timeout_ms).min(LIFETIME);
    if lifetime.is_zero() {
        return Ok(json!({ "status": "expired" }));
    }
    returns
        .listen(port, &path, &expected_state, &request_id, lifetime)
        .await
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
    if parsed.scheme() != "https" || !parsed.has_host() {
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
    use tokio::{
        io::{AsyncBufReadExt, BufReader},
        time::sleep,
    };

    const PATH: &str = "/callback";
    const STATE: &str = "test+state";
    const TARGET: &str = "/callback?code=synthetic&%73tate=test%2Bstate";
    const WAIT: Duration = Duration::from_secs(10);

    fn available_port() -> u16 {
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    async fn connect_when_ready(port: u16) -> TcpStream {
        timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(stream) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
                    return stream;
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }

    async fn request(address: SocketAddr, method: &str, target: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(format!("{method} {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut reader = BufReader::new(stream);
        timeout(Duration::from_secs(3), async {
            let mut answer = String::new();
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                answer.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let length: usize = answer
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            reader.read_exact(&mut body).await.unwrap();
            answer.push_str(&String::from_utf8(body).unwrap());
            // Like a browser, close after reading the advertised body, without waiting for FIN.
            answer
        })
        .await
        .unwrap()
    }

    #[test]
    fn validates_ports_and_paths() {
        assert!(allowed_port(54545));
        assert!(allowed_port(1455));
        assert!(!allowed_port(0));
        assert!(!allowed_port(54546));
        assert!(valid_path("/auth/callback"));
        for path in [
            "/",
            "callback",
            "//callback",
            "/callback?",
            "/callback#x",
            "/a/../callback",
            "/./callback",
            "/a/%2e%2E/callback",
            "/callback/.",
        ] {
            assert!(!valid_path(path), "accepted {path}");
        }
    }

    #[tokio::test]
    async fn wildcard_listeners_are_busy_on_both_families() {
        let returns = Returns::default();
        let addr4 = SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0));
        let addr6 = SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0));
        for address in [addr4, addr6] {
            // Simulate an external program that enabled reuse, as std and Tokio
            // listeners do by default on Unix.
            let occupied = match TcpListener::bind(address).await {
                Ok(socket) => socket,
                Err(err) if address.is_ipv6() && ipv6_unavailable(&err) => continue,
                Err(err) => panic!("wildcard fixture could not bind: {err}"),
            };
            let port = occupied.local_addr().unwrap().port();
            assert_eq!(
                returns
                    .listen(port, PATH, STATE, "one", WAIT)
                    .await
                    .unwrap()["status"],
                "busy"
            );
            let loopback = if address.is_ipv4() {
                SocketAddr::from((Ipv4Addr::LOCALHOST, port))
            } else {
                SocketAddr::from((Ipv6Addr::LOCALHOST, port))
            };
            assert_eq!(bind(loopback).unwrap_err().kind(), io::ErrorKind::AddrInUse);
        }
    }

    #[tokio::test]
    async fn rejects_forged_requests_and_accepts_only_one_exact_return() {
        let returns = Returns::default();
        let port = available_port();
        let ipv4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let ipv6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
        let clients = async {
            drop(connect_when_ready(port).await);
            for target in [
                "/favicon.ico",
                "/callback?code=x",
                "/callback?code=x&state=wrong",
                "/callback?code=x&state=test%2Bstate&%73tate=test%2Bstate",
                "/callbackX?state=test%2Bstate",
            ] {
                assert!(
                    request(ipv4, "GET", target)
                        .await
                        .starts_with("HTTP/1.1 404")
                );
            }
            assert!(
                request(ipv4, "POST", TARGET)
                    .await
                    .starts_with("HTTP/1.1 404")
            );
            let address = match bind((Ipv6Addr::LOCALHOST, 0).into()) {
                Ok(_) => ipv6,
                Err(err) if ipv6_unavailable(&err) => ipv4,
                Err(err) => panic!("could not reach IPv6 loopback: {err}"),
            };
            let response = request(address, "GET", TARGET).await;
            assert!(response.starts_with("HTTP/1.1 200"));
            assert!(response.contains("You can close this tab"));
            assert!(!response.contains("synthetic"));
            for header in [
                "Content-Type: text/html; charset=utf-8",
                "Cache-Control: no-store",
                "X-Content-Type-Options: nosniff",
                "Content-Security-Policy: default-src 'none'",
            ] {
                assert!(response.contains(header));
            }
            assert!(TcpStream::connect(ipv4).await.is_err());
        };
        let (result, ()) = tokio::join!(returns.listen(port, PATH, STATE, "one", WAIT), clients);
        assert_eq!(
            result.unwrap(),
            json!({
                "status": "returned",
                "address": format!("http://localhost:{port}{TARGET}"),
            })
        );
        // The completed listener must not keep the port in use.
        assert!(bind_loopback(port).is_ok());
    }

    #[tokio::test]
    async fn oversized_and_slow_requests_do_not_consume_the_return() {
        let returns = Returns::default();
        let port = available_port();
        let clients = async {
            let mut oversized = connect_when_ready(port).await;
            let payload = format!(
                "GET {TARGET} HTTP/1.1\r\nPadding: {}\r\n\r\n",
                "x".repeat(HEADER_LIMIT)
            );
            oversized.write_all(payload.as_bytes()).await.unwrap();
            assert_dropped(oversized).await;

            let mut slow = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            slow.write_all(b"GET /callback").await.unwrap();
            assert_dropped(slow).await;

            let address = (Ipv4Addr::LOCALHOST, port).into();
            assert!(
                request(address, "GET", TARGET)
                    .await
                    .starts_with("HTTP/1.1 200")
            );
        };
        let (result, ()) = tokio::join!(returns.listen(port, PATH, STATE, "one", WAIT), clients);
        assert_eq!(result.unwrap()["status"], "returned");
    }

    async fn assert_dropped(mut stream: TcpStream) {
        let read = timeout(Duration::from_secs(3), stream.read(&mut [0]))
            .await
            .unwrap();
        assert!(matches!(read, Ok(0)) || read.is_err());
    }

    #[tokio::test]
    async fn replacement_cancel_and_timeout_release_the_port() {
        let returns = Returns::default();
        let port = available_port();
        returns.stop(port, "early".into());
        assert_eq!(
            returns
                .listen(port, PATH, STATE, "early", WAIT)
                .await
                .unwrap()["status"],
            "cancelled"
        );
        let replace = async {
            drop(connect_when_ready(port).await);
            let cancel = async {
                // The newer request waits for the old one to release its binds.
                tokio::task::yield_now().await;
                returns.stop(port, "one".into());
                returns.stop(port, "two".into());
            };
            let (result, ()) = tokio::join!(returns.listen(port, PATH, STATE, "two", WAIT), cancel);
            assert_eq!(result.unwrap()["status"], "cancelled");
        };
        let (result, ()) = tokio::join!(returns.listen(port, PATH, STATE, "one", WAIT), replace);
        assert_eq!(result.unwrap()["status"], "cancelled");
        let short = Duration::from_millis(20);
        assert_eq!(
            returns
                .listen(port, PATH, STATE, "three", short)
                .await
                .unwrap()["status"],
            "expired"
        );
        assert!(bind_loopback(port).is_ok());
    }
}
