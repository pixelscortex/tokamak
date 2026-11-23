//! One pipe pair for the process; JavaScript stays on the owning plugin's thread.
pub(crate) mod inspect;
mod output;
mod plugin;
mod realm;

use std::{
    collections::HashMap,
    io,
    sync::{Arc, atomic::AtomicU64},
};

use anyhow::{Context, Result};
use serde_json::Value;
use tokamak_worker::WORKER_CAPACITY;
use tokio::sync::mpsc;

use output::Output;

pub(super) const BUNDLE: &str = "tokamak-action.js";

pub async fn run() -> Result<()> {
    let (input, mut frames) = mpsc::channel::<Value>(WORKER_CAPACITY);
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let mut reader = io::stdin().lock();
            while let Some(frame) = crate::protocol::read_frame(&mut reader)? {
                if frame["type"] == "shutdown" || input.blocking_send(frame).is_err() {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("input: {error:#}");
        }
        crate::protocol::shutdown();
    });

    let output = Arc::new(Output::start());
    let next_op = Arc::new(AtomicU64::new(0));
    let mut plugins = HashMap::<u64, plugin::Thread>::new();
    while let Some(frame) = frames.recv().await {
        if frame["type"] == "ping" {
            output.pong(number(&frame, "id")?)?;
            continue;
        }

        let slot = number(&frame, "slot")?;
        match frame["type"].as_str() {
            Some("drop") => {
                plugins.remove(&slot);
            }
            Some("invoke") => {
                let id = number(&frame, "id")?;
                let start = || plugin::Thread::start(slot, &frame, output.clone(), next_op.clone());
                if let std::collections::hash_map::Entry::Vacant(entry) = plugins.entry(slot) {
                    match start() {
                        Ok(thread) => {
                            entry.insert(thread);
                        }
                        Err(error) => {
                            output.error(slot, id, &error.to_string());
                            continue;
                        }
                    }
                }
                if plugins[&slot].send(frame).is_err() {
                    output.error(slot, id, "Plugin action runtime stopped");
                }
            }
            Some("cancel" | "opResult") => {
                if let Some(plugin) = plugins.get(&slot) {
                    let _ = plugin.send(frame);
                }
            }
            _ => anyhow::bail!("Invalid action process message"),
        }
    }
    Ok(())
}

fn number(frame: &Value, key: &str) -> Result<u64> {
    frame[key]
        .as_u64()
        .filter(|id| *id < 1 << 53)
        .with_context(|| format!("Invalid action process {key}"))
}
