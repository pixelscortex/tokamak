//! Native web capabilities exchange owned JSON/bytes, not QuickJS handles. A
//! future engine can reuse these operations and supply its own JS adapter.

use crate::{Error, Json, OpRegistry};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, mpsc};
use tokio_util::sync::CancellationToken;
use url::Url;

const CHUNK: usize = 64 * 1024;
const RESOURCES: usize = 64;
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

/// Every world owns one resource table. No detached task can outlive its lease;
/// abort wakes I/O even while another operation holds the response reader.
pub struct WebHost {
    resources: Arc<Mutex<Resources>>,
    permissions: Arc<Vec<String>>,
    client: reqwest::Client,
}
impl WebHost {
    pub fn new(permissions: Vec<String>) -> std::result::Result<Self, Error> {
        let client = reqwest::Client::builder()
            // JS follows redirects by opening another checked request. Disabling
            // implicit redirects prevents an allowed host lending its authority.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| Error::Engine(e.to_string()))?;
        Ok(Self {
            resources: Arc::default(),
            permissions: Arc::new(permissions),
            client,
        })
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
                let url = Url::parse(text(&p, "url")?).map_err(|e| e.to_string())?;
                self.permit(&url)?;
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

    fn permit(&self, url: &Url) -> Result<()> {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("fetch requires an http(s) URL without credentials".into());
        }
        let host = url.host_str().ok_or("fetch URL has no host")?;
        if !self.permissions.iter().any(|p| p == &format!("net:{host}")) {
            return Err(format!("fetch permission denied: requires net:{host}"));
        }
        Ok(())
    }

    async fn asynchronous(&self, p: Json) -> Result<Json> {
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
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("fetch aborted".into()),
            result = async {
                match operation {
                    "send" => {
                        let url = Url::parse(text(&p,"url")?).map_err(|e|e.to_string())?;
                        self.permit(&url)?;
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
                        let res = request.send().await.map_err(|e|e.to_string())?;
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
