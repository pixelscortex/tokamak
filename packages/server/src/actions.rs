//! Actions receive command capabilities, never a database handle or transaction.
//! A nested call rejoins the ordered coordinator and gets its own normal world.

use crate::{
    plugins::Loaded,
    service::{Command, FunctionKind},
};
use engine::{Limits, OpRegistry, Pool, PoolConfig};
use serde_json::Value as Json;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub(crate) struct NestedCall {
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
    environment: Arc<crate::environment::Snapshot>,
    limits: Limits,
    path: Vec<String>,
) -> Result<Arc<OpRegistry>, engine::Error> {
    let mut ops = OpRegistry::new();
    if let (Some(loaded), Some(owner)) = (&generation, &owner) {
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
    register_nested_calls(
        &mut ops,
        commands.clone(),
        generation.clone(),
        owner.clone(),
        environment.clone(),
    )?;
    if let (Some(loaded), Some(owner)) = (generation, owner) {
        register_plugin_call(
            &mut ops,
            loaded.clone(),
            owner.clone(),
            commands,
            limits,
            path,
        )?;
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

fn register_nested_calls(
    ops: &mut OpRegistry,
    commands: mpsc::WeakSender<Command>,
    generation: Option<Arc<Loaded>>,
    owner: Option<String>,
    environment: Arc<crate::environment::Snapshot>,
) -> Result<(), engine::Error> {
    for (operation, kind) in [
        ("action.runQuery", FunctionKind::Query),
        ("action.runMutation", FunctionKind::Mutation),
    ] {
        let commands = commands.clone();
        let generation = generation.clone();
        let owner = owner.clone();
        let environment = environment.clone();
        ops.register_async(operation, move |payload| {
            let environment = environment.clone();
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

    Ok(())
}

fn register_plugin_call(
    ops: &mut OpRegistry,
    loaded: Arc<Loaded>,
    owner: String,
    commands: mpsc::WeakSender<Command>,
    limits: Limits,
    path: Vec<String>,
) -> Result<(), engine::Error> {
    let catalog = loaded.clone();
    let caller = owner.clone();
    ops.register_async("plugin.call", move |payload| {
        let loaded = catalog.clone();
        let owner = caller.clone();
        let commands = commands.clone();
        let limits = limits.clone();
        let mut path = path.clone();
        async move {
            let name = payload["name"]
                .as_str()
                .ok_or("plugin call requires a function name")?;
            let args = payload
                .get("args")
                .ok_or("plugin call requires args")?
                .clone();
            let target = loaded.action_target(&owner, name, &path)?;
            if target.kind != FunctionKind::Action {
                let (reply, wait) = oneshot::channel();
                commands
                    .upgrade()
                    .ok_or("server is closed")?
                    .try_send(Command::RunFunction(NestedCall {
                        generation: Some(loaded),
                        owner: Some(owner),
                        name: name.into(),
                        args,
                        kind: target.kind,
                        reply,
                    }))
                    .map_err(|e| format!("nested call not admitted: {e}"))?;
                return wait
                    .await
                    .map_err(|_| "server closed before plugin call completed".to_owned())?;
            }
            path.push(name.into());
            let environment = Arc::new(crate::environment::Snapshot::new(
                Some(&loaded),
                Some(&target.owner),
            ));
            let worker = loaded.workers.get(&target.owner).cloned();
            let ops = operations(
                commands,
                Some(loaded),
                Some(target.owner),
                environment.clone(),
                limits.clone(),
                path,
            )
            .map_err(|e| e.to_string())?;
            if let Some(worker) = worker {
                return worker
                    .invoke(target.local_name, args, ops)
                    .await
                    .map_err(|e| environment.redact(e));
            }
            // A separate, invocation-owned lane avoids recursive waits on the
            // bounded root action pool. Dropping it cancels the child on reload.
            let pool = Pool::new_actions(PoolConfig {
                workers: 1,
                queue_capacity: 1,
                limits,
            })
            .map_err(|e| e.to_string())?;
            let pending = pool
                .submit(
                    target.bundle,
                    "invoke",
                    serde_json::json!({"name": target.local_name, "args": args}),
                    ops,
                )
                .map_err(|e| e.to_string())?;
            pending.await.map_err(|e| environment.redact(e.to_string()))
        }
    })?;

    Ok(())
}
