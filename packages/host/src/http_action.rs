//! One isolated host for one HTTP request. Pipe capacity provides backpressure
//! without queueing chunks in either process.
use std::{
    collections::BTreeMap,
    future::poll_fn,
    io::{self, BufReader, Read, Write},
    path::Path,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result, ensure};
use engine::{Invocation, install_ops, web};
use rquickjs::{
    AsyncContext, AsyncRuntime, CaughtError, Ctx, Exception, Function, Module, Object, Promise,
    TypedArray, function::Async,
};
use serde_json::{Value, json};
use tokamak_worker::{
    HTTP_ACTION_LOG_PACKET, HTTP_ACTION_OP_CAPACITY, HTTP_ACTION_OP_PACKET, WORKER_FRAME_BYTES,
};
use tokio::sync::{oneshot, watch};

use crate::watchdog::Watchdog;

const HEAD_BYTES: usize = 256 * 1024;
const BODY_BYTES: usize = 32 * 1024 * 1024;
const CHUNK_BYTES: usize = 64 * 1024;

pub(crate) async fn run(path: &Path) -> Result<()> {
    let upstream = Arc::new(Upstream::default());
    let (head, body, disconnected) = receive(upstream.clone())?;
    let metadata: Value = serde_json::from_str(&head)?;
    let heap = metadata["heap"]
        .as_u64()
        .context("Missing HTTP action heap budget")?;
    let permissions = serde_json::from_value(metadata["permissions"].clone())?;
    let source = std::fs::read(path)?;
    let runtime = AsyncRuntime::new()?;
    runtime.set_memory_limit(usize::try_from(heap)?).await;
    let watchdog = Rc::new(Watchdog::default());
    let interrupt = watchdog.clone();
    runtime
        .set_interrupt_handler(Some(Box::new(move || interrupt.interrupt())))
        .await;

    let web = web::WebHost::new(permissions)?;
    let _lease = web.lease();
    let operations = Arc::new(web.operations()?);
    let invocation = Invocation::unbounded();
    let context = AsyncContext::full(&runtime).await?;
    let execution = context.async_with(async |ctx| {
        let run = async {
            let capability = install_ops(&ctx, operations, &invocation)?;
            web::install(&ctx, capability, true)?;
            install_console(&ctx)?;
            let call_upstream = upstream.bridge(&ctx)?;

            let (entry, evaluated) = Module::declare(
                ctx.clone(),
                "tokamak:http-action",
                include_str!("http_action.js"),
            )?
            .eval()?;
            evaluated.into_future::<()>().await?;
            let serve: Function = entry.get("serve")?;
            let (plugin, evaluated) =
                Module::declare(ctx.clone(), "tokamak-http-actions.js", source)?.eval()?;
            evaluated.into_future::<()>().await?;
            let handlers: Object = plugin.get("handlers")?;

            let (head_out, chunk_out) = output_functions(&ctx)?;
            let wait_for_abort = Function::new(
                ctx.clone(),
                Async(move || {
                    let mut disconnected = disconnected.clone();
                    async move {
                        let _ = disconnected.wait_for(|stopped| *stopped).await;
                    }
                }),
            )?;
            let pending: Promise = serve.call((
                handlers,
                head,
                TypedArray::new(ctx.clone(), body)?,
                head_out,
                chunk_out,
                wait_for_abort,
                call_upstream,
            ))?;
            pending.into_future::<()>().await
        }
        .await;
        run.map_err(|error| anyhow::anyhow!("{}", CaughtError::from_error(&ctx, error)))
    });
    let mut execution = std::pin::pin!(execution);
    poll_fn(|cx| {
        use std::future::Future;
        watchdog.poll(|| execution.as_mut().poll(cx))
    })
    .await
    .map_err(|error| {
        log(&error.to_string());
        anyhow::anyhow!("HTTP action execution failed")
    })?;
    write_packet(&mut io::stdout().lock(), 0, &[])?;
    Ok(())
}

fn output_functions<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<(Function<'js>, Function<'js>)> {
    let head = Function::new(ctx.clone(), |ctx: Ctx<'_>, head: String| {
        if head.len() > HEAD_BYTES {
            return Err(Exception::throw_message(
                &ctx,
                "HTTP action response headers are too large",
            ));
        }
        write_packet(&mut io::stdout().lock(), 0, head.as_bytes())
            .map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
    })?;
    let chunk = Function::new(ctx.clone(), |ctx: Ctx<'_>, chunk: TypedArray<'_, u8>| {
        // SAFETY: This host runs one JS realm on this thread, with no
        // workers or shared native buffers. No JS runs during the write.
        let result = match unsafe { chunk.as_bytes() } {
            Some(bytes) => {
                let mut output = io::stdout().lock();
                bytes
                    .chunks(CHUNK_BYTES)
                    .try_for_each(|part| write_packet(&mut output, 0, part))
            }
            None => return Err(Exception::throw_type(&ctx, "Invalid response chunk")),
        };
        result.map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
    })?;
    Ok((head, chunk))
}

fn receive(upstream: Arc<Upstream>) -> Result<(String, Vec<u8>, watch::Receiver<bool>)> {
    let mut input = BufReader::new(io::stdin());
    let mut size = [0; 4];
    input.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    ensure!(
        size <= HEAD_BYTES,
        "HTTP action request headers are too large"
    );
    let mut head = vec![0; size];
    input.read_exact(&mut head)?;
    let head = String::from_utf8(head)?;
    let metadata: Value = serde_json::from_str(&head)?;
    let length = metadata["length"]
        .as_u64()
        .context("Missing HTTP action body length")?;
    ensure!(
        length <= BODY_BYTES as u64,
        "HTTP action request body is too large"
    );
    let mut body = vec![0; length as usize];
    input.read_exact(&mut body)?;

    let (stop, disconnected) = watch::channel(false);
    // EOF signals the handler on a live server, and the fallback also retires
    // the host if its parent dies and cannot enforce the grace period.
    std::thread::spawn(move || {
        while let Ok(reply) = read_reply(&mut input) {
            if let Ok(mut pending) = upstream.pending.lock()
                && let Some(waiters) = pending.as_mut()
                && let Some(id) = reply["id"].as_u64()
                && let Some(waiter) = waiters.remove(&id)
            {
                let _ = waiter.send(reply);
            }
        }
        if let Ok(mut pending) = upstream.pending.lock() {
            pending.take();
        }
        let _ = stop.send(true);
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(0);
    });
    Ok((head, body, disconnected))
}

fn write_packet(output: &mut impl Write, kind: u32, bytes: &[u8]) -> io::Result<()> {
    output.write_all(&(kind | bytes.len() as u32).to_be_bytes())?;
    output.write_all(bytes)?;
    output.flush()
}

fn install_console(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let console = Object::new(ctx.clone())?;
    for level in ["log", "info", "warn", "error", "debug"] {
        use rquickjs::{Coerced, prelude::Rest};
        console.set(
            level,
            Function::new(ctx.clone(), |values: Rest<Coerced<String>>| {
                log(&values
                    .0
                    .into_iter()
                    .map(|value| value.0)
                    .collect::<Vec<_>>()
                    .join(" "));
            })?,
        )?;
    }
    ctx.globals().set("console", console)
}

fn log(message: &str) {
    if message.len() <= WORKER_FRAME_BYTES {
        let _ = write_packet(
            &mut io::stdout().lock(),
            HTTP_ACTION_LOG_PACKET,
            message.as_bytes(),
        );
    }
}

type Waiters = BTreeMap<u64, oneshot::Sender<Value>>;

struct Upstream {
    next: AtomicU64,
    pending: Mutex<Option<Waiters>>,
}

impl Default for Upstream {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(0),
            pending: Mutex::new(Some(BTreeMap::new())),
        }
    }
}

impl Upstream {
    fn bridge<'js>(self: Arc<Self>, ctx: &Ctx<'js>) -> rquickjs::Result<Function<'js>> {
        Function::new(
            ctx.clone(),
            Async(move |name: String, payload: String| {
                let upstream = self.clone();
                async move {
                    match upstream.call(&name, &payload).await {
                        Ok(reply) => reply.to_string(),
                        Err(error) => json!({"error": error}).to_string(),
                    }
                }
            }),
        )
    }

    async fn call(&self, name: &str, payload: &str) -> Result<Value, String> {
        let payload: Value = serde_json::from_str(payload).map_err(|error| error.to_string())?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let frame = serde_json::to_vec(&json!({"id": id, "name": name, "payload": payload}))
            .map_err(|error| error.to_string())?;
        if frame.len() > WORKER_FRAME_BYTES {
            return Err("HTTP action operation exceeds 1 MiB".into());
        }
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "HTTP action input closed")?;
            let pending = pending.as_mut().ok_or("HTTP action input closed")?;
            if pending.len() >= HTTP_ACTION_OP_CAPACITY {
                return Err("HTTP action operation capacity exceeded".into());
            }
            pending.insert(id, send);
        }
        if let Err(error) = write_packet(&mut io::stdout().lock(), HTTP_ACTION_OP_PACKET, &frame) {
            if let Ok(mut pending) = self.pending.lock()
                && let Some(pending) = pending.as_mut()
            {
                pending.remove(&id);
            }
            return Err(error.to_string());
        }
        receive.await.map_err(|_| "HTTP action input closed".into())
    }
}

fn read_reply(input: &mut impl Read) -> Result<Value> {
    let mut header = [0; 4];
    input.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    ensure!(
        size <= WORKER_FRAME_BYTES,
        "HTTP action reply exceeds 1 MiB"
    );
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
