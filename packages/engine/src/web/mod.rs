//! Native web capabilities exchange owned JSON/bytes, not QuickJS handles. A
//! future engine can reuse these operations and supply its own JS adapter.

use crate::{Error, Json, OpRegistry};
use serde_json::json;
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
use url::Url;

const CHUNK: usize = 64 * 1024;
const RESOURCES: usize = 64;
const DNS_TIMEOUT: Duration = Duration::from_secs(10);
// Process-wide, including retired worker generations. A timed-out/cancelled
// lookup keeps its permit until getaddrinfo actually returns, bounding orphans.
static DNS_LOOKUPS: Semaphore = Semaphore::const_new(16);
type Result<T> = std::result::Result<T, String>;

struct Exchange {
    cancel: CancellationToken,
    upload: Option<mpsc::Sender<Vec<u8>>>,
    receiver: Option<mpsc::Receiver<Vec<u8>>>,
    response: Arc<AsyncMutex<Option<reqwest::Response>>>,
    remainder: Vec<u8>,
}

#[derive(Default)]
struct Resources {
    next: u64,
    requests: BTreeMap<u64, Exchange>,
    timers: BTreeMap<u64, CancellationToken>,
    decoders: BTreeMap<u64, encoding_rs::Decoder>,
}
impl Resources {
    fn id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }
    fn capacity(&self) -> Result<()> {
        if self.requests.len() + self.timers.len() + self.decoders.len() >= RESOURCES {
            Err("web resource limit exceeded (64)".into())
        } else {
            Ok(())
        }
    }
}

/// Owned by the invocation, independently of JS/native promise reference cycles.
/// Dropping an invocation future also retires resources without running JS cleanup.
pub(crate) struct WebLease(Arc<Mutex<Resources>>);
impl Drop for WebLease {
    fn drop(&mut self) {
        let mut resources = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for (_, exchange) in std::mem::take(&mut resources.requests) {
            exchange.cancel.cancel();
            if let Ok(mut response) = exchange.response.try_lock() {
                response.take();
            }
        }
        for (_, timer) in std::mem::take(&mut resources.timers) {
            timer.cancel();
        }
        resources.decoders.clear();
    }
}

/// Every world owns one resource table; abort wakes I/O even while another
/// operation holds the response reader. OS DNS jobs may outlive the world, but
/// retain only owned host/address data and their process-wide capacity permit.
pub struct WebHost {
    resources: Arc<Mutex<Resources>>,
    permissions: Vec<String>,
    client: reqwest::Client,
}
impl WebHost {
    pub fn new(permissions: Vec<String>) -> std::result::Result<Self, Error> {
        let permissions = permissions
            .iter()
            .filter_map(|p| p.strip_prefix("net:"))
            .map(canonical_host)
            .collect::<Result<Vec<_>>>()
            .map_err(Error::InvalidInput)?;
        let client = reqwest::Client::builder()
            // Ambient proxies would resolve/connect outside our address filter.
            .no_proxy()
            .dns_resolver(Arc::new(PublicResolver))
            // Each exchange owns its connection: abort must close the socket,
            // rather than leave an idle pooled or multiplexed connection alive.
            .http1_only()
            .pool_max_idle_per_host(0)
            // JS follows redirects by opening another checked request. Disabling
            // implicit redirects prevents an allowed host lending its authority.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| Error::Engine(e.to_string()))?;
        Ok(Self {
            resources: Arc::default(),
            permissions,
            client,
        })
    }

    pub(crate) fn lease(&self) -> WebLease {
        WebLease(self.resources.clone())
    }

    pub fn operations(self) -> std::result::Result<OpRegistry, Error> {
        let host = Arc::new(self);
        let mut ops = OpRegistry::new();
        let h = host.clone();
        ops.register_sync("web.sync", move |p| h.sync(p))?;
        ops.register_async("web.async", move |p| {
            let h = host.clone();
            async move { h.asynchronous(p).await }
        })?;
        Ok(ops)
    }

    fn sync(&self, p: Json) -> Result<Json> {
        let mut r = self
            .resources
            .lock()
            .map_err(|_| "web resource lock poisoned")?;
        match text(&p, "op")? {
            "open" => {
                let mut url = Url::parse(text(&p, "url")?).map_err(|e| e.to_string())?;
                self.permit(&mut url)?;
                r.capacity()?;
                let id = r.id();
                let (upload, receiver) = if p["stream"].as_bool() == Some(true) {
                    let (s, r) = mpsc::channel(1);
                    (Some(s), Some(r))
                } else {
                    (None, None)
                };
                r.requests.insert(
                    id,
                    Exchange {
                        cancel: CancellationToken::new(),
                        upload,
                        receiver,
                        response: Arc::default(),
                        remainder: Vec::new(),
                    },
                );
                Ok(json!(id))
            }
            "cancel" => {
                if let Some(x) = r.requests.remove(&id(&p)?) {
                    x.cancel.cancel();
                    if let Ok(mut response) = x.response.try_lock() {
                        response.take();
                    }
                }
                Ok(Json::Null)
            }
            "finish" => {
                if let Some(x) = r.requests.get_mut(&id(&p)?) {
                    x.upload.take();
                }
                Ok(Json::Null)
            }
            "timer" => {
                r.capacity()?;
                let id = r.id();
                r.timers.insert(id, CancellationToken::new());
                Ok(json!(id))
            }
            "clearTimer" => {
                if let Some(cancel) = r.timers.remove(&id(&p)?) {
                    cancel.cancel();
                }
                Ok(Json::Null)
            }
            "random" => {
                let size = p["size"]
                    .as_u64()
                    .filter(|n| *n <= CHUNK as u64)
                    .ok_or("getRandomValues quota exceeded")? as usize;
                let mut bytes = vec![0; size];
                getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
                Ok(json!(bytes))
            }
            "encode" => Ok(json!(text(&p, "text")?.as_bytes())),
            "decoder" => {
                r.capacity()?;
                let encoding = encoding_rs::Encoding::for_label(text(&p, "label")?.as_bytes())
                    .ok_or("unsupported text encoding")?;
                let decoder = if p["ignoreBOM"].as_bool() == Some(true) {
                    encoding.new_decoder_without_bom_handling()
                } else {
                    encoding.new_decoder_with_bom_removal()
                };
                let id = r.id();
                r.decoders.insert(id, decoder);
                Ok(json!(id))
            }
            "decode" => {
                let bytes = bytes(&p["bytes"])?;
                let decoder = r
                    .decoders
                    .get_mut(&id(&p)?)
                    .ok_or("text decoder is closed")?;
                let last = p["last"].as_bool() == Some(true);
                let mut output = String::with_capacity(
                    decoder
                        .max_utf8_buffer_length(bytes.len())
                        .ok_or("decoder input too large")?,
                );
                let (_, _, errors) = decoder.decode_to_string(&bytes, &mut output, last);
                if errors && p["fatal"].as_bool() == Some(true) {
                    return Err("invalid encoded text".into());
                }
                Ok(json!(output))
            }
            "closeDecoder" => {
                r.decoders.remove(&id(&p)?);
                Ok(Json::Null)
            }
            "url" => {
                let raw = text(&p, "url")?;
                let mut url = if let Some(base) = p["base"].as_str() {
                    Url::parse(base).and_then(|u| u.join(raw))
                } else {
                    Url::parse(raw)
                }
                .map_err(|e| e.to_string())?;
                if let Some(key) = p["set"].as_str() {
                    let value = text(&p, "value")?;
                    match key {
                        "protocol" => url
                            .set_scheme(value.trim_end_matches(':'))
                            .map_err(|_| "invalid URL scheme")?,
                        "hostname" => url.set_host(Some(value)).map_err(|e| e.to_string())?,
                        "host" => {
                            let parsed = Url::parse(&format!("{}://{value}", url.scheme()))
                                .map_err(|e| e.to_string())?;
                            url.set_host(parsed.host_str()).map_err(|e| e.to_string())?;
                            url.set_port(parsed.port()).map_err(|_| "invalid port")?;
                        }
                        "port" => url
                            .set_port(if value.is_empty() {
                                None
                            } else {
                                Some(value.parse().map_err(|_| "invalid port")?)
                            })
                            .map_err(|_| "invalid port")?,
                        "pathname" => url.set_path(value),
                        "search" => url.set_query(if value.is_empty() {
                            None
                        } else {
                            Some(value.trim_start_matches('?'))
                        }),
                        "hash" => url.set_fragment(if value.is_empty() {
                            None
                        } else {
                            Some(value.trim_start_matches('#'))
                        }),
                        "username" => url.set_username(value).map_err(|_| "invalid username")?,
                        "password" => url
                            .set_password(Some(value))
                            .map_err(|_| "invalid password")?,
                        _ => return Err("unsupported URL property".into()),
                    }
                }
                Ok(
                    json!({"href":url.as_str(),"protocol":format!("{}:",url.scheme()),"hostname":url.host_str().unwrap_or(""),"port":url.port().map(|p|p.to_string()).unwrap_or_default(),"host":url[url::Position::BeforeHost..url::Position::AfterPort],"origin":url.origin().ascii_serialization(),"pathname":url.path(),"search":url.query().map(|q|format!("?{q}")).unwrap_or_default(),"hash":url.fragment().map(|f|format!("#{f}")).unwrap_or_default(),"username":url.username(),"password":url.password().unwrap_or("")}),
                )
            }
            _ => Err("unsupported native web operation".into()),
        }
    }

    fn permit(&self, url: &mut Url) -> Result<()> {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("fetch requires an http(s) URL without credentials".into());
        }
        let host = canonical_host(url.host_str().ok_or("fetch URL has no host")?)?;
        if !self.permissions.contains(&host) {
            return Err(format!("fetch permission denied: requires net:{host}"));
        }
        // Use the same canonical host for authority and transport, including
        // mapped IPv6 and WHATWG's alternate IPv4 spellings.
        url.set_host(Some(&host)).map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn asynchronous(self: Arc<Self>, p: Json) -> Result<Json> {
        // A pending read may hold the response lock when JS aborts and then
        // keeps running. Drive native I/O on the background executor so token
        // cancellation can drop that reader/socket without another JS poll.
        // The world's future owns this handle; no native task is detached.
        let task =
            tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move { self.io(p).await }));
        task.await
            .map_err(|e| format!("native web operation stopped: {e}"))?
    }

    async fn io(&self, p: Json) -> Result<Json> {
        let operation = text(&p, "op")?;
        let request_id = id(&p)?;
        if operation == "sleep" {
            let cancel = self
                .resources
                .lock()
                .map_err(|_| "web resource lock poisoned")?
                .timers
                .get(&request_id)
                .cloned()
                .ok_or("timer is closed")?;
            let ms = p["ms"]
                .as_u64()
                .ok_or("invalid timer delay")?
                .min(2_147_483_647);
            let fired = tokio::select! { _ = tokio::time::sleep(Duration::from_millis(ms)) => true, _ = cancel.cancelled() => false };
            self.resources
                .lock()
                .map_err(|_| "web resource lock poisoned")?
                .timers
                .remove(&request_id);
            return Ok(json!(fired));
        }
        let (cancel, response) = {
            let r = self
                .resources
                .lock()
                .map_err(|_| "web resource lock poisoned")?;
            let x = r
                .requests
                .get(&request_id)
                .ok_or("fetch is aborted or closed")?;
            (x.cancel.clone(), x.response.clone())
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("fetch aborted".into()),
            result = async {
                match operation {
                    "send" => {
                        let mut url = Url::parse(text(&p,"url")?).map_err(|e|e.to_string())?;
                        self.permit(&mut url)?;
                        let method = reqwest::Method::from_bytes(text(&p,"method")?.as_bytes()).map_err(|e|e.to_string())?;
                        let mut request = self.client.request(method,url);
                        for pair in p["headers"].as_array().ok_or("invalid headers")? {
                            request = request.header(pair[0].as_str().ok_or("invalid header name")?,pair[1].as_str().ok_or("invalid header value")?);
                        }
                        let receiver = self.resources.lock().map_err(|_| "web resource lock poisoned")?.requests.get_mut(&request_id).ok_or("fetch aborted")?.receiver.take();
                        if let Some(receiver) = receiver {
                            let stream = futures_util::stream::unfold(receiver, |mut receiver| async { receiver.recv().await.map(|b| (Ok::<_,std::io::Error>(b),receiver)) });
                            request = request.body(reqwest::Body::wrap_stream(stream));
                        }
                        let res = request.send().await.map_err(fetch_error)?;
                        let headers: Vec<_> = res.headers().iter().map(|(k,v)| vec![k.as_str().to_owned(),String::from_utf8_lossy(v.as_bytes()).into_owned()]).collect();
                        let result = json!({"status":res.status().as_u16(),"statusText":res.status().canonical_reason().unwrap_or(""),"headers":headers,"url":res.url().as_str()});
                        *response.lock().await = Some(res);
                        Ok(result)
                    }
                    "write" => {
                        let sender = self.resources.lock().map_err(|_| "web resource lock poisoned")?.requests.get(&request_id).and_then(|x|x.upload.clone()).ok_or("request body is closed")?;
                        sender.send(bytes(&p["bytes"])?).await.map_err(|_|"request body receiver closed")?;
                        Ok(Json::Null)
                    }
                    "read" => {
                        let remainder = {
                            let mut r = self.resources.lock().map_err(|_|"web resource lock poisoned")?;
                            std::mem::take(&mut r.requests.get_mut(&request_id).ok_or("fetch aborted")?.remainder)
                        };
                        let mut data = if remainder.is_empty() {
                            let mut guard = response.lock().await;
                            let res = guard.as_mut().ok_or("response is closed")?;
                            match res.chunk().await.map_err(|e|e.to_string())? {
                                Some(chunk) => chunk.to_vec(),
                                None => {
                                    guard.take();
                                    self.resources.lock().map_err(|_|"web resource lock poisoned")?.requests.remove(&request_id);
                                    return Ok(Json::Null);
                                }
                            }
                        } else { remainder };
                        if data.len() > CHUNK {
                            let tail = data.split_off(CHUNK);
                            if let Some(x) = self.resources.lock().map_err(|_|"web resource lock poisoned")?.requests.get_mut(&request_id) { x.remainder = tail; }
                        }
                        Ok(json!(data))
                    }
                    _ => Err("unsupported async web operation".into()),
                }
            } => result
        };
        if result.is_err() {
            // A transport/read/upload failure is terminal even if JS catches it
            // or stops polling the corresponding promise.
            if let Some(exchange) = self
                .resources
                .lock()
                .map_err(|_| "web resource lock poisoned")?
                .requests
                .remove(&request_id)
            {
                exchange.cancel.cancel();
                if let Ok(mut response) = exchange.response.try_lock() {
                    response.take();
                }
            }
        }
        result
    }
}

// Parse grants as hosts, never as URLs: credentials, ports and URL delimiters
// must not lend authority to a different host. url supplies IDNA and IPv4 parsing.
fn canonical_host(raw: &str) -> Result<String> {
    if raw.is_empty()
        || raw
            .chars()
            .any(|c| c.is_whitespace() || "/\\@?#".contains(c))
    {
        return Err("invalid network permission host".into());
    }
    let host = if let Ok(ip) = raw.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => url::Host::Ipv4(ip),
            IpAddr::V6(ip) => url::Host::Ipv6(ip),
        }
    } else {
        url::Host::parse(raw).map_err(|e| e.to_string())?
    };
    Ok(match host {
        url::Host::Domain(name) => name.trim_end_matches('.').to_ascii_lowercase(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => ip.to_string(),
            None => format!("[{ip}]"),
        },
    })
}

struct PublicResolver;
impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            // localhost is the sole name with local authority; do not trust
            // hosts-file/DNS overrides to turn that grant into another network.
            let addresses: Vec<_> = if host == "localhost" {
                vec![
                    (IpAddr::V4(Ipv4Addr::LOCALHOST), 0).into(),
                    (IpAddr::V6(Ipv6Addr::LOCALHOST), 0).into(),
                ]
            } else {
                let addresses = tokio::time::timeout(DNS_TIMEOUT, async move {
                    let permit = DNS_LOOKUPS.acquire().await.map_err(std::io::Error::other)?;
                    let task = tokio_util::task::AbortOnDropHandle::new(
                        tokio::task::spawn_blocking(move || {
                            // Only owned host/address data crosses this boundary;
                            // no invocation, resource table or JS state is retained.
                            let _permit = permit;
                            (host.as_str(), 0)
                                .to_socket_addrs()
                                .map(|addresses| addresses.collect::<Vec<_>>())
                        }),
                    );
                    // Abort queued work on timeout/cancellation. Running OS
                    // lookups cannot be interrupted and retain their permits.
                    task.await.map_err(std::io::Error::other)?
                })
                .await
                .map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "DNS resolution timed out after 10 seconds",
                    )
                })??;
                addresses
                    .into_iter()
                    .filter(|address| public_address(address.ip()))
                    .collect()
            };
            if addresses.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "network hostname resolved to no permitted public addresses",
                )
                .into());
            }
            // reqwest connects directly to this iterator. There is no second
            // DNS lookup between validating an address and opening its socket.
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

// reqwest's Display omits DNS causes. Keep the chain so JS receives the
// resolver's timeout/permission diagnostic instead of only a request URL.
fn fetch_error(error: reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut cause = std::error::Error::source(&error);
    while let Some(error) = cause {
        message.push_str(": ");
        message.push_str(&error.to_string());
        cause = error.source();
    }
    message
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                && !(a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public_address(IpAddr::V4(ip));
            }
            let s = ip.segments();
            // Conservatively allow global unicast only, excluding protocol,
            // documentation and transition ranges (including embedded IPv4).
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn text<'a>(p: &'a Json, key: &str) -> Result<&'a str> {
    p[key]
        .as_str()
        .ok_or_else(|| format!("web operation requires {key}"))
}
fn id(p: &Json) -> Result<u64> {
    p["id"]
        .as_u64()
        .ok_or_else(|| "web operation requires id".into())
}
fn bytes(p: &Json) -> Result<Vec<u8>> {
    let array = p
        .as_array()
        .filter(|a| a.len() <= CHUNK)
        .ok_or("web byte chunk exceeds 64 KiB")?;
    array
        .iter()
        .map(|v| {
            v.as_u64()
                .filter(|n| *n <= 255)
                .map(|n| n as u8)
                .ok_or_else(|| "invalid byte".into())
        })
        .collect()
}

/// Only this adapter knows the engine. The native resource table and permission
/// gate above remain independent of context, promises, and JS object lifetimes.
pub fn install<'js>(
    ctx: &rquickjs::Ctx<'js>,
    host: rquickjs::Object<'js>,
    network: bool,
) -> rquickjs::Result<()> {
    ctx.eval::<(), _>(include_str!("vendor/streams.js"))?;
    let factory: rquickjs::Function = ctx.eval(include_str!("surface.js"))?;
    factory.call::<_, ()>((host, network))
}
