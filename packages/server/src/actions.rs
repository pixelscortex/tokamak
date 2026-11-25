//! Actions receive command capabilities, never a database handle or transaction.
//! A nested call rejoins the ordered coordinator and gets its own normal world.

use crate::host::action_process::Supervisor;
use crate::identity::CallNote;
use crate::{
    plugins::Loaded,
    service::{Command, FunctionKind},
};
use engine::OpRegistry;
use serde_json::Value as Json;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub(crate) struct NestedCall {
    pub note: CallNote,
    pub generation: Option<Arc<Loaded>>,
    pub owner: Option<String>,
    pub name: String,
    pub args: Json,
    pub kind: FunctionKind,
    pub contract: Option<String>,
    pub reply: oneshot::Sender<Result<Json, crate::protocol::CallError>>,
}

pub(crate) fn operations(
    commands: mpsc::WeakSender<Command>,
    generation: Option<Arc<Loaded>>,
    owner: Option<String>,
    environment: Arc<crate::environment::Snapshot>,
    process: Arc<Supervisor>,
    note: CallNote,
) -> Result<Arc<OpRegistry>, engine::Error> {
    let mut ops = OpRegistry::new();
    note.register(&mut ops)?;
    if let (Some(loaded), Some(owner)) = (&generation, &owner) {
        ops.set_network_permissions(
            loaded.catalog.plugins[owner]
                .manifest
                .plugin
                .permissions
                .clone(),
        );
    }
    engine::register_password_crypto(&mut ops)?;
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
        note.clone(),
    )?;
    if let (Some(loaded), Some(owner)) = (generation, owner) {
        register_plugin_call(
            &mut ops,
            loaded.clone(),
            owner.clone(),
            commands,
            process,
            note,
        )?;
        crate::plugins::register_contract_list(&mut ops, loaded, owner)?;
    }
    Ok(Arc::new(ops))
}

pub(crate) fn register_nested_calls(
    ops: &mut OpRegistry,
    commands: mpsc::WeakSender<Command>,
    generation: Option<Arc<Loaded>>,
    owner: Option<String>,
    environment: Arc<crate::environment::Snapshot>,
    note: CallNote,
) -> Result<(), engine::Error> {
    for (operation, kind) in [
        ("action.runQuery", FunctionKind::Query),
        ("action.runMutation", FunctionKind::Mutation),
    ] {
        let commands = commands.clone();
        let generation = generation.clone();
        let owner = owner.clone();
        let environment = environment.clone();
        let note = note.clone();
        ops.register_call(operation, move |payload| {
            let environment = environment.clone();
            let commands = commands.clone();
            let generation = generation.clone();
            let owner = owner.clone();
            let note = note.clone();
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
                        note,
                        generation,
                        owner,
                        name,
                        args,
                        kind,
                        contract: None,
                        reply,
                    }))
                    .map_err(|e| format!("nested call not admitted: {e}"))?;
                // Once admitted, disconnect/shutdown cannot retract a mutation's
                // commit. The coordinator owns finalization and the writer barrier.
                wait.await
                    .map_err(|_| "server closed before nested call completed".to_owned())?
                    .map_err(|error| error.map_text(|text| environment.redact(text)).into())
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
    process: Arc<Supervisor>,
    note: CallNote,
) -> Result<(), engine::Error> {
    let catalog = loaded.clone();
    let caller = owner.clone();
    ops.register_call("plugin.call", move |payload| {
        let loaded = catalog.clone();
        let owner = caller.clone();
        let commands = commands.clone();
        let process = process.clone();
        let note = note.clone();
        async move {
            let name = payload["name"]
                .as_str()
                .ok_or("plugin call requires a function name")?;
            let args = payload
                .get("args")
                .ok_or("plugin call requires args")?
                .clone();
            let contract = payload.get("contract").and_then(Json::as_str);
            let target = loaded.action_target(&owner, name, contract)?;
            target.kind.check_requested(&payload)?;
            if target.kind != FunctionKind::Action {
                let (reply, wait) = oneshot::channel();
                commands
                    .upgrade()
                    .ok_or("server is closed")?
                    .try_send(Command::RunFunction(NestedCall {
                        note,
                        generation: Some(loaded),
                        owner: Some(owner),
                        name: name.into(),
                        args,
                        kind: target.kind,
                        contract: contract.map(str::to_owned),
                        reply,
                    }))
                    .map_err(|e| format!("nested call not admitted: {e}"))?;
                return wait
                    .await
                    .map_err(|_| "server closed before plugin call completed")?
                    .map_err(Into::into);
            }
            let note = note
                .enter(name, Some(&target.args), &args)
                .map_err(|error| error.to_string())?;
            let environment = Arc::new(crate::environment::Snapshot::new(
                Some(&loaded),
                Some(&target.owner),
            ));
            let source = loaded
                .action_sources
                .get(&target.owner)
                .cloned()
                .ok_or("Plugin action has no action process bundle")?;
            let ops = operations(
                commands,
                Some(loaded),
                Some(target.owner),
                environment.clone(),
                process.clone(),
                note,
            )
            .map_err(|e| e.to_string())?;
            process
                .invoke(source, target.local_name, args, ops)
                .await
                .map_err(|error| environment.redact(error).into())
        }
    })?;

    Ok(())
}
