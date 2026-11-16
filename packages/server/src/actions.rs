//! Actions receive command capabilities, never a database handle or transaction.
//! A nested call rejoins the ordered coordinator and gets its own normal world.

use crate::{
    plugins::Loaded,
    service::{Command, FunctionKind},
};
use engine::OpRegistry;
use serde_json::Value as Json;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub(crate) struct NestedCall {
    pub caller: crate::members::Caller,
    pub generation: Option<Arc<Loaded>>,
    pub owner: Option<String>,
    pub name: String,
    pub args: Json,
    pub kind: FunctionKind,
    pub reply: oneshot::Sender<Result<Json, String>>,
}

pub(crate) fn operations(
    commands: mpsc::WeakSender<Command>,
    generation: Option<Arc<Loaded>>,
    owner: Option<String>,
    identity: crate::members::Caller,
    environment: Arc<crate::environment::Snapshot>,
) -> Result<Arc<OpRegistry>, engine::Error> {
    let mut ops = OpRegistry::new();
    identity.register(&mut ops);
    if let (Some(loaded), Some(owner)) = (&generation, &owner) {
        if !identity.is_guest() {
            crate::host::acp::register(
                &mut ops,
                loaded.catalog.acp.clone(),
                owner.clone(),
                loaded.catalog.plugins[owner]
                    .manifest
                    .plugin
                    .permissions
                    .iter()
                    .any(|p| p == "acp"),
            )?;
        }
        ops.set_network_permissions(
            loaded.catalog.plugins[owner]
                .manifest
                .plugin
                .permissions
                .clone(),
        );
    }
    let values = environment.clone();
    ops.register_sync("action.env", move |payload| {
        let name = payload["name"].as_str().ok_or("env requires a name")?;
        values
            .get(name)
            .map(|value| value.map(Json::String).unwrap_or(Json::Null))
    })?;
    for (operation, kind) in [
        ("action.runQuery", FunctionKind::Query),
        ("action.runMutation", FunctionKind::Mutation),
    ] {
        let identity = identity.clone();
        let commands = commands.clone();
        let generation = generation.clone();
        let owner = owner.clone();
        let environment = environment.clone();
        ops.register_async(operation, move |payload| {
            let environment = environment.clone();
            let identity = identity.clone();
            let commands = commands.clone();
            let generation = generation.clone();
            let owner = owner.clone();
            async move {
                let name = payload["name"]
                    .as_str()
                    .ok_or("nested call requires a function name")?
                    .to_owned();
                let args = payload
                    .get("args")
                    .ok_or("nested call requires args")?
                    .clone();
                let (reply, wait) = oneshot::channel();
                commands
                    .upgrade()
                    .ok_or("server is closed")?
                    .try_send(Command::RunFunction(NestedCall {
                        caller: identity,
                        generation,
                        owner,
                        name,
                        args,
                        kind,
                        reply,
                    }))
                    .map_err(|e| format!("nested call not admitted: {e}"))?;
                // Once admitted, disconnect/shutdown cannot retract a mutation's
                // commit. The coordinator owns finalization and the writer barrier.
                wait.await
                    .map_err(|_| "server closed before nested call completed".to_owned())?
                    .map_err(|error| environment.redact(error))
            }
        })?;
    }
    if let (Some(loaded), Some(owner)) = (generation, owner) {
        register_providers(&mut ops, loaded, owner)?;
    }
    Ok(Arc::new(ops))
}

fn register_providers(
    ops: &mut OpRegistry,
    loaded: Arc<Loaded>,
    owner: String,
) -> Result<(), engine::Error> {
    ops.register_sync("plugin.providers", move |payload| {
        let interface = payload["interface"]
            .as_str()
            .ok_or("providers requires an interface")?;
        loaded
            .catalog
            .providers(&owner, interface)
            .map(|ids| serde_json::json!(ids))
            .map_err(|e| e.to_string())
    })
}
