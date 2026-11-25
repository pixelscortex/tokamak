//! One isolated host for one HTTP request. Pipe capacity provides backpressure
//! without queueing chunks in either process.
use std::{
    future::poll_fn,
    io::{self, BufReader, Read, Write},
    path::Path,
    rc::Rc,
    sync::Arc,
};

use anyhow::{Context, Result, ensure};
use engine::{Invocation, install_ops, web};
use rquickjs::{
    AsyncContext, AsyncRuntime, CaughtError, Ctx, Exception, Function, Module, Object, Promise,
    TypedArray, function::Async,
};
use serde_json::Value;

use crate::watchdog::Watchdog;

const HEAD_BYTES: usize = 256 * 1024;
const BODY_BYTES: usize = 32 * 1024 * 1024;
const CHUNK_BYTES: usize = 64 * 1024;

pub(crate) async fn run(path: &Path) -> Result<()> {
    let (head, body, disconnected) = receive()?;
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
    .await?;
    write_packet(&mut io::stdout().lock(), &[])?;
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
        write_packet(&mut io::stdout().lock(), head.as_bytes())
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
                    .try_for_each(|part| write_packet(&mut output, part))
            }
            None => return Err(Exception::throw_type(&ctx, "Invalid response chunk")),
        };
        result.map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
    })?;
    Ok((head, chunk))
}

fn receive() -> Result<(String, Vec<u8>, tokio::sync::watch::Receiver<bool>)> {
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

    let (stop, disconnected) = tokio::sync::watch::channel(false);
    // EOF signals the handler on a live server, and the fallback also retires
    // the host if its parent dies and cannot enforce the grace period.
    std::thread::spawn(move || {
        let _ = input.read(&mut [0_u8; 1]);
        let _ = stop.send(true);
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(0);
    });
    Ok((head, body, disconnected))
}

fn write_packet(output: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    output.write_all(&(bytes.len() as u32).to_be_bytes())?;
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
                eprintln!(
                    "{}",
                    values
                        .0
                        .into_iter()
                        .map(|value| value.0)
                        .collect::<Vec<_>>()
                        .join(" ")
                );
            })?,
        )?;
    }
    ctx.globals().set("console", console)
}
