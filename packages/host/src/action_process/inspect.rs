//! Examine an older combined bundle without loading its modules in the server.

use std::{path::Path, sync::Arc};

use anyhow::{Context, Result};
use engine::{Bundle, Engine, Limits, OpRegistry, QuickJsEngine};
use serde_json::{Value, json};

pub(crate) async fn run(path: &Path) -> Result<()> {
    let frame = match contains_actions(path).await {
        Ok(has_actions) => json!({"hasActions": has_actions}),
        Err(error) => json!({"error": format!("{error:#}")}),
    };
    serde_json::to_writer(std::io::stdout().lock(), &frame)?;
    println!();
    Ok(())
}

async fn contains_actions(path: &Path) -> Result<bool> {
    let source = std::fs::read_to_string(path).context("Read verified server bundle")?;
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
