//! Evaluate verified action bundles outside the server.

use std::{path::Path, sync::Arc};

use anyhow::{Context, Result};
use engine::{Bundle, Engine, Limits, OpRegistry, QuickJsEngine};
use serde_json::{Value, json};

pub(crate) async fn run(path: &Path) -> Result<()> {
    let frame = match inspect(path).await {
        Ok(frame) => frame,
        Err(error) => json!({"error": format!("{error:#}")}),
    };
    serde_json::to_writer(std::io::stdout().lock(), &frame)?;
    println!();
    Ok(())
}

async fn inspect(path: &Path) -> Result<Value> {
    let source = std::fs::read_to_string(path).context("Read verified server bundle")?;
    if let Ok(options) = std::env::var("TOKAMAK_ACTION_INSPECT") {
        let (heap, worker_entry) = options
            .split_once(':')
            .context("Invalid action inspection options")?;
        super::call::inspect(&source, heap.parse()?, worker_entry.parse()?).await?;
        return Ok(json!({"ok": true}));
    }

    Ok(json!({"hasActions": contains_actions(source).await?}))
}

async fn contains_actions(source: String) -> Result<bool> {
    let bundle = Bundle::new(source, None)?;
    let mut engine = QuickJsEngine::new(Limits::default())?;
    let descriptor = engine
        .invoke(
            &bundle,
            "describe",
            Value::Null,
            Arc::new(OpRegistry::new()),
        )
        .await?;
    let functions = descriptor["functions"]
        .as_array()
        .context("Bundle descriptor must list functions")?;
    Ok(functions
        .iter()
        .any(|function| function["kind"] == "action"))
}
