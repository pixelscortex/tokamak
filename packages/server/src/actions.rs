//! Actions receive command capabilities, never a database handle or transaction.
//! A nested call rejoins the ordered coordinator and gets its own normal world.

use crate::host::action_process::Supervisor;
use crate::{identity::CallNote, protocol::ActionTarget};
use crate::{
    plugins::Loaded,
    service::{Command, FunctionKind},
};
use engine::OpRegistry;
use serde_json::Value as Json;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};
use tokio::sync::{mpsc, oneshot};

pub type RunnerFuture = Pin<Box<dyn Future<Output = Result<Json, String>> + Send>>;
type RunnerDispatch = Arc<dyn Fn(RunnerAction) -> RunnerFuture + Send + Sync>;
pub(crate) type RunnerSlot = OnceLock<RunnerDispatch>;

pub struct RunnerAction {
    pub plugin: String,
    pub entry_hash: String,
    pub code_hash: String,
    pub name: String,
    pub args: Json,
    pub ops: Arc<OpRegistry>,
}

pub(crate) enum Destination {
    Server,
    Runner {
        dispatch: RunnerDispatch,
        plugin: String,
        entry_hash: String,
        code_hash: String,
    },
    Missing,
}

pub(crate) fn resolve(
    loaded: Option<&Loaded>,
    target: Option<&crate::plugins::Target>,
    on: Option<ActionTarget>,
    runner: &RunnerSlot,
    note: &CallNote,
    from_server: bool,
) -> Destination {
    let selected = on.unwrap_or_else(|| target.map(|target| target.on).unwrap_or_default());
    let personal = note
        .auth
        .as_ref()
        .is_some_and(|auth| auth.device.id != "device:server");
    if personal
        && selected == ActionTarget::Caller
        && from_server
        && let Some(dispatch) = runner.get()
        && let (Some(loaded), Some(target)) = (loaded, target)
    {
        let manifest = &loaded.catalog.plugins[&target.owner].manifest;
        if let Some(local) = &manifest.entries.local
            && let (Some(entry_hash), Some(code_hash)) = (
                manifest.hashes.get(&local.entry),
                manifest.hashes.get(&local.code),
            )
        {
            return Destination::Runner {
                dispatch: dispatch.clone(),
                plugin: target.owner.clone(),
                entry_hash: entry_hash.clone(),
                code_hash: code_hash.clone(),
            };
        }
    }

    match selected {
        ActionTarget::Server => Destination::Server,
        ActionTarget::Caller => Destination::Missing,
    }
}

impl Destination {
    pub async fn invoke(
        self,
        process: &Supervisor,
        source: Option<Arc<crate::host::action_process::Source>>,
        name: String,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<Json, String> {
        match self {
            Self::Server => {
                process
                    .invoke(
                        source.ok_or("Plugin action has no action process bundle")?,
                        name,
                        args,
                        ops,
                    )
                    .await
            }
            Self::Runner {
                dispatch,
                plugin,
                entry_hash,
                code_hash,
            } => {
                dispatch(RunnerAction {
                    plugin,
                    entry_hash,
                    code_hash,
                    name,
                    args,
                    ops,
                })
                .await
            }
            Self::Missing => Ok(no_machine()),
        }
    }
}

pub(crate) fn no_machine() -> Json {
    serde_json::json!({"failed":true,"kind":"noMachine","data":null})
}

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
    (note, runner): (CallNote, Arc<RunnerSlot>),
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
            runner,
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
    runner: Arc<RunnerSlot>,
) -> Result<(), engine::Error> {
    let catalog = loaded.clone();
    let caller = owner.clone();
    ops.register_call("plugin.call", move |payload| {
        let loaded = catalog.clone();
        let owner = caller.clone();
        let commands = commands.clone();
        let process = process.clone();
        let runner = runner.clone();
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
            let on = payload
                .get("on")
                .map(|on| serde_json::from_value(on.clone()))
                .transpose()
                .map_err(|_| "Invalid action target")?;
            let destination = resolve(Some(&loaded), Some(&target), on, &runner, &note, true);
            if matches!(destination, Destination::Missing) {
                return Ok(no_machine());
            }

            let source = loaded.action_sources.get(&target.owner).cloned();
            let ops = operations(
                commands,
                Some(loaded),
                Some(target.owner.clone()),
                environment.clone(),
                process.clone(),
                (note, runner.clone()),
            )
            .map_err(|e| e.to_string())?;
            let result = destination
                .invoke(&process, source, target.local_name, args, ops)
                .await;

            result.map_err(|error| environment.redact(error).into())
        }
    })?;

    Ok(())
}
