//! Actions receive command capabilities, never a database handle or transaction.
//! A nested call rejoins the ordered coordinator and gets its own normal world.

use crate::host::{
    action_process::Supervisor,
    hooks::{HookTarget, Stage, run_after, run_before},
};
use crate::plugins::Hook;
use crate::protocol::CallError;
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
use tokio_util::sync::{CancellationToken, DropGuard};

mod runner_hooks;
pub use runner_hooks::RunnerHookPlan;
mod runner_upstream;
use runner_upstream::ActionOperations;
pub use runner_upstream::RunnerActionUpstream;
pub(crate) use runner_upstream::runner_hashes;

pub type RunnerFuture = Pin<Box<dyn Future<Output = Result<Json, engine::CallError>> + Send>>;
type RunnerDispatch = Arc<dyn Fn(RunnerAction) -> RunnerFuture + Send + Sync>;
pub(crate) type RunnerSlot = OnceLock<RunnerDispatch>;

pub struct RunnerAction {
    pub plugin: String,
    pub entry_hash: String,
    pub code_hash: String,
    pub name: String,
    pub args: Json,
    pub upstream: RunnerActionUpstream,
    pub retiring: tokio_util::sync::CancellationToken,
}

pub(crate) enum Destination {
    Server,
    AttachedRunner {
        dispatch: RunnerDispatch,
        plugin: String,
        entry_hash: String,
        code_hash: String,
    },
    CallerWindowRunner {
        plugin: String,
        entry_hash: String,
        code_hash: String,
    },
    Failed(MachineFailure),
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Placement {
    on: Option<ActionTarget>,
    window: bool,
    pub(crate) hook_plans: bool,
}

impl Placement {
    pub fn new(on: Option<ActionTarget>, window: Option<bool>, hook_plans: Option<bool>) -> Self {
        Self {
            on,
            window: window.unwrap_or(false),
            hook_plans: hook_plans.unwrap_or(false),
        }
    }

    pub fn response(self, value: Json) -> Json {
        if self.window {
            serde_json::json!({"destination":"result","value":value})
        } else {
            value
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum MachineFailure {
    NoMachine,
}

impl MachineFailure {
    pub fn value(self) -> Json {
        match self {
            Self::NoMachine => serde_json::json!({"failed":true,"kind":"noMachine","data":null}),
        }
    }
}

pub(crate) fn resolve(
    loaded: Option<&Loaded>,
    target: Option<&crate::plugins::Target>,
    placement: Placement,
    runner: &RunnerSlot,
    note: &CallNote,
) -> Destination {
    let selected = placement
        .on
        .unwrap_or_else(|| target.map(|target| target.on).unwrap_or_default());
    if selected == ActionTarget::Server {
        return Destination::Server;
    }

    let Some(auth) = note.auth.as_ref().filter(|auth| auth.is_person()) else {
        return Destination::Failed(MachineFailure::NoMachine);
    };
    if let (Some(loaded), Some(target)) = (loaded, target) {
        let manifest = &loaded.catalog.plugins[&target.owner].manifest;
        if let Some((entry_hash, code_hash)) = runner_hashes(manifest) {
            if auth.is_on_this_machine()
                && !note.is_window_continuation()
                && let Some(dispatch) = runner.get()
            {
                return Destination::AttachedRunner {
                    dispatch: dispatch.clone(),
                    plugin: target.owner.clone(),
                    entry_hash: entry_hash.to_owned(),
                    code_hash: code_hash.to_owned(),
                };
            }
            if placement.window {
                return Destination::CallerWindowRunner {
                    plugin: target.owner.clone(),
                    entry_hash: entry_hash.to_owned(),
                    code_hash: code_hash.to_owned(),
                };
            }
        }
    }

    Destination::Failed(MachineFailure::NoMachine)
}

impl Destination {
    pub fn context(
        &self,
        note: CallNote,
        runner: Arc<RunnerSlot>,
    ) -> (ActionContext, Option<DropGuard>) {
        let lifetime = matches!(self, Self::AttachedRunner { .. }).then(CancellationToken::new);
        let guard = lifetime.clone().map(CancellationToken::drop_guard);
        (
            ActionContext {
                note,
                runner,
                lifetime,
            },
            guard,
        )
    }

    pub fn immediate_reply(
        &self,
        note: &CallNote,
        loaded: Option<&Loaded>,
        name: &str,
        owns_hook_scope: bool,
    ) -> Option<Json> {
        match self {
            Self::CallerWindowRunner {
                plugin,
                entry_hash,
                code_hash,
            } => Some(serde_json::json!({
                "destination":"callerWindowRunner",
                "note":note.continuation(),
                "ownsHookScope": owns_hook_scope,
                "artifact":{"id":plugin,"entryHash":entry_hash,"codeHash":code_hash},
                "hooks": loaded.and_then(|loaded| RunnerHookPlan::load(loaded, name)),
            })),
            _ => None,
        }
    }

    pub async fn invoke(
        self,
        process: &Supervisor,
        source: Option<Arc<crate::host::action_process::Source>>,
        name: String,
        args: Json,
        upstream: ActionOperations,
    ) -> Result<Json, CallError> {
        let Some(scope) = upstream.scope.clone() else {
            return self
                .invoke_owner(process, source, name, args, upstream, None)
                .await
                .map_err(Into::into);
        };
        let Some(target) = HookTarget::load(&scope.generation, &format!("{}/{name}", scope.owner))
        else {
            return self
                .invoke_owner(process, source, name, args, upstream, None)
                .await
                .map_err(Into::into);
        };
        let note = scope.note.clone();
        let stages = ActionStageExecutor {
            generation: &scope.generation,
            commands: &scope.commands,
            process: &scope.process,
            runner: &scope.runner,
            lifetime: scope.lifetime.clone(),
            dispatch: match &self {
                Self::AttachedRunner { dispatch, .. } => Some(dispatch.clone()),
                _ => None,
            },
        };
        let retirement = if stages.dispatch.is_some() {
            Some(
                source
                    .clone()
                    .ok_or("Plugin action has no action process bundle")?,
            )
        } else {
            None
        };
        let chain = |retiring| {
            run_action(
                &target,
                &note,
                args,
                |hook, _, note, input| stages.execute(hook, note, input),
                |args| self.invoke_owner(process, source, name, args, upstream, retiring),
            )
        };
        match retirement {
            Some(source) => {
                process
                    .invoke_runner(&source, |retiring| chain(Some(retiring)))
                    .await
            }
            None => chain(None).await,
        }
        .map_err(Into::into)
    }

    async fn invoke_owner(
        self,
        process: &Supervisor,
        source: Option<Arc<crate::host::action_process::Source>>,
        name: String,
        args: Json,
        upstream: ActionOperations,
        retiring: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<Json, engine::CallError> {
        match self {
            Self::Server => {
                process
                    .invoke_typed(
                        source.ok_or("Plugin action has no action process bundle")?,
                        name,
                        args,
                        upstream.ops,
                    )
                    .await
            }
            Self::AttachedRunner {
                dispatch,
                plugin,
                entry_hash,
                code_hash,
            } => {
                let run = |retiring| {
                    dispatch(RunnerAction {
                        plugin,
                        entry_hash,
                        code_hash,
                        name,
                        args,
                        upstream: RunnerActionUpstream(upstream),
                        retiring,
                    })
                };
                match retiring {
                    Some(retiring) => run(retiring).await,
                    None => {
                        let source = source.ok_or("Plugin action has no action process bundle")?;
                        process.invoke_runner(&source, run).await
                    }
                }
            }
            Self::Failed(error) => Ok(error.value()),
            Self::CallerWindowRunner { .. } => {
                Err("Window action dispatch requires a window request".into())
            }
        }
    }
}

struct ActionStageExecutor<'a> {
    generation: &'a Arc<Loaded>,
    commands: &'a mpsc::WeakSender<Command>,
    process: &'a Arc<Supervisor>,
    runner: &'a Arc<RunnerSlot>,
    dispatch: Option<RunnerDispatch>,
    lifetime: Option<CancellationToken>,
}

impl ActionStageExecutor<'_> {
    async fn execute(
        &self,
        hook: Hook,
        note: CallNote,
        input: Json,
    ) -> Result<Json, engine::CallError> {
        let environment = Arc::new(crate::environment::Snapshot::new(
            Some(self.generation),
            Some(&hook.owner),
        ));
        let ops = operations(
            self.commands.clone(),
            Some(self.generation.clone()),
            Some(hook.owner.clone()),
            environment.clone(),
            self.process.clone(),
            ActionContext {
                note,
                runner: self.runner.clone(),
                lifetime: self.lifetime.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        let source = self
            .generation
            .action_sources
            .get(&hook.owner)
            .cloned()
            .ok_or("Missing hook action bundle")?;
        let name = format!("@hook/{}", hook.name);
        let result = if let Some(dispatch) = &self.dispatch {
            let (entry_hash, code_hash) =
                runner_hashes(&self.generation.catalog.plugins[&hook.owner].manifest)
                    .ok_or_else(runner_action_artifact_unavailable)?;
            self.process
                .invoke_runner(&source, |retiring| {
                    dispatch(RunnerAction {
                        plugin: hook.owner,
                        entry_hash: entry_hash.to_owned(),
                        code_hash: code_hash.to_owned(),
                        name,
                        args: input,
                        upstream: RunnerActionUpstream(ops),
                        retiring,
                    })
                })
                .await
        } else {
            self.process
                .invoke_typed(source, name, input, ops.ops)
                .await
        };
        result.map_err(|error| {
            let limit = error.limit.clone();
            let kind = error.kind;
            let mut error = engine::CallError::from(
                CallError::from(error).map_text(|text| environment.redact(text)),
            );
            error.limit = limit;
            error.kind = kind;
            error
        })
    }
}

async fn run_action<S, O>(
    target: &HookTarget,
    note: &CallNote,
    args: Json,
    mut stage: impl FnMut(Hook, Stage, CallNote, Json) -> S,
    owner: impl FnOnce(Json) -> O,
) -> Result<Json, engine::CallError>
where
    S: Future<Output = Result<Json, engine::CallError>>,
    O: Future<Output = Result<Json, engine::CallError>>,
{
    let args = run_before(target, note, args, &mut stage).await?;
    let result = owner(args.clone()).await?;
    if crate::protocol::failure_kind(&result).is_some() {
        return Ok(result);
    }
    run_after(target, note, result, &args, stage).await
}

pub fn runner_action_artifact_unavailable() -> engine::CallError {
    engine::CallError {
        kind: Some(engine::CallErrorKind::RunnerArtifactUnavailable),
        ..engine::CallError::from("Runner action artifact unavailable")
    }
}

#[derive(Clone)]
pub(crate) struct ActionContext {
    pub note: CallNote,
    pub runner: Arc<RunnerSlot>,
    pub lifetime: Option<CancellationToken>,
}

pub(crate) struct NestedCall {
    pub note: CallNote,
    pub generation: Option<Arc<Loaded>>,
    pub lifetime: Option<CancellationToken>,
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
    context: ActionContext,
) -> Result<ActionOperations, engine::Error> {
    let mut ops = OpRegistry::new();
    context.note.register(&mut ops)?;
    if let (Some(loaded), Some(owner)) = (&generation, &owner) {
        ops.set_network_permissions(
            loaded.catalog.plugins[owner]
                .manifest
                .plugin
                .permissions
                .clone(),
        );
    }
    environment.register(&mut ops)?;
    register_nested_calls(
        &mut ops,
        commands.clone(),
        generation.clone(),
        owner.clone(),
        environment.clone(),
        context.note.clone(),
        context.lifetime.clone(),
    )?;
    if let (Some(loaded), Some(owner)) = (&generation, &owner) {
        register_plugin_call(
            &mut ops,
            loaded.clone(),
            owner.clone(),
            commands.clone(),
            process.clone(),
            &context,
        )?;
        if let Some(lifetime) = &context.lifetime {
            let lifetime = lifetime.clone();
            let commands = commands.clone();
            let owner = owner.clone();
            ops.register_call("contract.list", move |payload| {
                let (lifetime, commands, owner) =
                    (lifetime.clone(), commands.clone(), owner.clone());
                async move {
                    let current = current_plugins(&commands, &lifetime).await?;
                    current
                        .contract_providers(&owner, &payload)
                        .map_err(Into::into)
                }
            })?;
        } else {
            crate::plugins::register_contract_list(&mut ops, loaded.clone(), owner.clone())?;
        }
    }
    Ok(ActionOperations::new(
        Arc::new(ops),
        generation,
        owner,
        commands,
        process,
        context,
        environment,
    ))
}

pub(crate) fn register_nested_calls(
    ops: &mut OpRegistry,
    commands: mpsc::WeakSender<Command>,
    generation: Option<Arc<Loaded>>,
    owner: Option<String>,
    environment: Arc<crate::environment::Snapshot>,
    note: CallNote,
    lifetime: Option<CancellationToken>,
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
        let lifetime = lifetime.clone();
        ops.register_call(operation, move |payload| {
            let environment = environment.clone();
            let commands = commands.clone();
            let generation = generation.clone();
            let owner = owner.clone();
            let note = note.clone();
            let lifetime = lifetime.clone();
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
                        lifetime,
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
    context: &ActionContext,
) -> Result<(), engine::Error> {
    let catalog = loaded.clone();
    let caller = owner;
    let ActionContext {
        note,
        runner,
        lifetime,
    } = context.clone();
    ops.register_call("plugin.call", move |payload| {
        let loaded = catalog.clone();
        let owner = caller.clone();
        let commands = commands.clone();
        let process = process.clone();
        let runner = runner.clone();
        let note = note.clone();
        let lifetime = lifetime.clone();
        async move {
            let loaded = match &lifetime {
                Some(token) => current_plugins(&commands, token).await?,
                None => loaded,
            };
            if !loaded.catalog.plugins.contains_key(&owner) {
                return Err("Calling plugin was removed".into());
            }
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
                        lifetime,
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
            let note = note.enter(name, Some(&target.args), &args)?;
            let on = requested_placement(&payload)?;
            run_nested_action(
                loaded,
                target,
                commands,
                process,
                ActionContext {
                    note,
                    runner,
                    lifetime,
                },
                args,
                on,
            )
            .await
        }
    })?;

    Ok(())
}

async fn run_nested_action(
    loaded: Arc<Loaded>,
    target: crate::plugins::Target,
    commands: mpsc::WeakSender<Command>,
    process: Arc<Supervisor>,
    parent: ActionContext,
    args: Json,
    on: Option<ActionTarget>,
) -> Result<Json, engine::CallError> {
    let destination = resolve(
        Some(&loaded),
        Some(&target),
        Placement::new(on, None, None),
        &parent.runner,
        &parent.note,
    );
    if let Destination::Failed(error) = destination {
        return Ok(error.value());
    }

    let environment = Arc::new(crate::environment::Snapshot::new(
        Some(&loaded),
        Some(&target.owner),
    ));
    let source = loaded.action_sources.get(&target.owner).cloned();
    let (context, _guard) = destination.context(parent.note, parent.runner);
    let ops = operations(
        commands,
        Some(loaded),
        Some(target.owner),
        environment.clone(),
        process.clone(),
        context,
    )
    .map_err(|e| e.to_string())?;
    let invocation = destination.invoke(&process, source, target.local_name, args, ops);
    let result = if let Some(lifetime) = parent.lifetime {
        tokio::select! {
            biased;
            () = lifetime.cancelled() => return Err("Action cancelled".into()),
            result = invocation => result,
        }
    } else {
        invocation.await
    };

    result.map_err(|error| error.map_text(|text| environment.redact(text)).into())
}

fn requested_placement(payload: &Json) -> Result<Option<ActionTarget>, &'static str> {
    payload
        .get("on")
        .map(|on| serde_json::from_value(on.clone()))
        .transpose()
        .map_err(|_| "Invalid action target")
}

async fn current_plugins(
    commands: &mpsc::WeakSender<Command>,
    lifetime: &CancellationToken,
) -> Result<Arc<Loaded>, String> {
    let (reply, wait) = oneshot::channel();
    commands
        .upgrade()
        .ok_or("Server closed")?
        .try_send(Command::CurrentPlugins(reply))
        .map_err(|error| error.to_string())?;
    tokio::select! {
        biased;
        () = lifetime.cancelled() => Err("Action cancelled".into()),
        result = wait => result
            .map_err(|_| "Server closed")?
            .ok_or_else(|| "Plugin catalog unavailable".into()),
    }
}
