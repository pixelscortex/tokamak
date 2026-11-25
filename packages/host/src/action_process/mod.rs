//! One pipe pair for the process; each running call owns its JavaScript thread.
mod call;
mod calls;
mod heap;
pub(crate) mod inspect;
mod output;
mod realm;

use std::{io, sync::Arc};

use anyhow::{Context, Result};
use serde_json::Value;
use tokamak_worker::WORKER_CAPACITY;
use tokio::sync::mpsc;

use output::Output;

pub(super) const BUNDLE: &str = "tokamak-action.js";

pub async fn run() -> Result<()> {
    abort_on_panic();

    let (input, mut frames) = mpsc::channel::<Value>(WORKER_CAPACITY);
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let mut reader = io::stdin().lock();
            while let Some(frame) = crate::pipe::read_frame(&mut reader)? {
                if frame["type"] == "shutdown" || input.blocking_send(frame).is_err() {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("input: {error:#}");
        }
        crate::pipe::shutdown();
    });

    let output = Arc::new(Output::start());
    let (complete, mut completed) = mpsc::unbounded_channel();
    let mut calls = calls::Calls::new(output.clone(), complete);
    loop {
        let frame = tokio::select! {
            biased;
            Some(key) = completed.recv() => {
                calls.finished(key);
                continue;
            }
            frame = frames.recv() => {
                let Some(frame) = frame else { break };
                frame
            }
        };
        if frame["type"] == "ping" {
            output.pong(number(&frame, "id")?)?;
            continue;
        }

        let slot = number(&frame, "slot")?;
        match frame["type"].as_str() {
            Some("drop") => calls.retire(slot),
            Some("invoke") => calls.invoke(slot, number(&frame, "id")?, frame),
            Some("cancel") => calls.cancel(slot, number(&frame, "id")?),
            Some("opResult") => calls.op_result(slot, number(&frame, "call")?, frame),
            _ => anyhow::bail!("Invalid action process message"),
        }
    }
    Ok(())
}

fn abort_on_panic() {
    let report_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        report_panic(panic);
        std::process::abort();
    }));
}

fn number(frame: &Value, key: &str) -> Result<u64> {
    frame[key]
        .as_u64()
        .filter(|id| *id < 1 << 53)
        .with_context(|| format!("Invalid action process {key}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_call_thread_panic_aborts_the_action_process() {
        use std::{os::unix::process::ExitStatusExt, process::Command};

        const CHILD: &str = "TOKAMAK_TEST_ACTION_PANIC";
        if std::env::var_os(CHILD).is_some() {
            super::abort_on_panic();
            let _ = std::thread::spawn(|| panic!("action thread panic")).join();
            return;
        }

        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "action_process::tests::a_call_thread_panic_aborts_the_action_process",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap()
            .status;
        assert_eq!(status.signal(), Some(libc::SIGABRT));
    }
}
