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
        let mut r = self.resources.lock().map_err(|_| "web resource lock poisoned")?;

        match text(&p, "op")? {
            "open" | "cancel" | "finish" => self.fetch_sync(&mut r, &p),
            "timer" | "clearTimer" => timers::sync(&mut r, &p),
            "random" => {
                let size = p["size"]
                    .as_u64()
                    .filter(|n| *n <= CHUNK as u64)
                    .ok_or("getRandomValues quota exceeded")? as usize;

                let mut bytes = vec![0; size];
                getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;

                Ok(json!(bytes))
            }
            "encode" | "decoder" | "decode" | "closeDecoder" => decoding::sync(&mut r, &p),
            "url" => urls::parse(&p),
            _ => Err("unsupported native web operation".into()),
        }
    }

    async fn asynchronous(self: Arc<Self>, p: Json) -> Result<Json> {
        // A pending read may hold the response lock when JS aborts and then
        // keeps running. Drive native I/O on the background executor so token
        // cancellation can drop that reader/socket without another JS poll.
        // The world's future owns this handle; no native task is detached.
        let task =
            tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move { self.io(p).await }));
        task.await.map_err(|e| format!("native web operation stopped: {e}"))?
    }
}

fn text<'a>(p: &'a Json, key: &str) -> Result<&'a str> {
    p[key].as_str().ok_or_else(|| format!("web operation requires {key}"))
}

fn id(p: &Json) -> Result<u64> {
    p["id"].as_u64().ok_or_else(|| "web operation requires id".into())
}

fn bytes(p: &Json) -> Result<Vec<u8>> {
    let array = p.as_array().filter(|a| a.len() <= CHUNK).ok_or("web byte chunk exceeds 64 KiB")?;
    array
        .iter()
        .map(|v| {
            v.as_u64().filter(|n| *n <= 255).map(|n| n as u8).ok_or_else(|| "invalid byte".into())
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

mod decoding;
mod fetch;
mod network;
mod timers;
mod urls;

use network::{PublicResolver, canonical_host};
