//! Actions receive command capabilities, never a database handle or transaction.
//! A nested call rejoins the ordered coordinator and gets its own normal world.

use crate::host::{
    action_process::Supervisor,
    hooks::{HookTarget, Stage, point_targets, run_after, run_before, run_point},
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
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::{CancellationToken, DropGuard};

mod runner_hooks;
pub use runner_hooks::RunnerHookPlan;
mod runner_upstream;
use runner_upstream::ActionOperations;
pub use runner_upstream::RunnerActionUpstream;
pub(crate) use runner_upstream::runner_hashes;

pub type RunnerFuture = Pin<Box<dyn Future<Output = Result<Json, engine::CallError>> + Send>>;
pub(crate) type RunnerDispatch = Arc<dyn Fn(RunnerAction) -> RunnerFuture + Send + Sync>;
mod http;
pub(crate) use http::HttpCalls;
mod machines;
use machines::Selection;
pub(crate) use machines::{Machines, Owner as MachineOwner};

#[derive(Clone)]
pub(crate) struct RunnerConnection {
    pub dispatch: RunnerDispatch,
    pub stage_plans: bool,
}

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
    AttachedRunner(RunnerDestination),
    ConnectedRunner(RunnerDestination),
    CallerWindowRunner {
        plugin: String,
        entry_hash: String,
        code_hash: String,
    },
    Failed(MachineFailure),
}

pub(crate) struct RunnerDestination {
    connection: RunnerConnection,
    plugin_machine: bool,
    plugin: String,
    entry_hash: String,
    code_hash: String,
}

#[derive(Default)]
pub(crate) struct Placement {
    on: Option<ActionTarget>,
    window: bool,
    pub(crate) hook_plans: bool,
    pub(crate) point_plans: bool,
}

impl Placement {
    pub fn new(
        on: Option<ActionTarget>,
        window: Option<bool>,
        hook_plans: Option<bool>,
        point_plans: Option<bool>,
    ) -> Self {
        Self {
            on,
            window: window.unwrap_or(false),
            hook_plans: hook_plans.unwrap_or(false),
            point_plans: point_plans.unwrap_or(false),
        }
    }

    pub fn response(&self, value: Json) -> Json {
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
    MachineLost,
    Offline,
    Forbidden,
    Limit,
}

impl MachineFailure {
    pub fn value(self) -> Json {
        let kind = match self {
            Self::NoMachine => "noMachine",
            Self::MachineLost => "machineLost",
            Self::Offline => "machineOffline",
            Self::Forbidden => "machineForbidden",
            Self::Limit => "machineLimit",
        };
        serde_json::json!({"failed":true,"kind":kind,"data":null})
    }
}

pub(crate) fn resolve(
    loaded: Option<&Loaded>,
    target: Option<&crate::plugins::Target>,
    placement: &Placement,
    caller: Option<(&str, bool)>,
    runner: &Machines,
    note: &CallNote,
) -> Destination {
    let selected = placement
        .on
        .as_ref()
        .or_else(|| target.map(|target| &target.on))
        .unwrap_or(&ActionTarget::Server);
    if *selected == ActionTarget::Server {
        return Destination::Server;
    }

    let named = if let ActionTarget::Machine(id) = selected {
        let Some(plugin) = target.map(|target| target.owner.as_str()) else {
            return Destination::Failed(MachineFailure::Forbidden);
        };
        if id.starts_with("machine:") && caller.is_some_and(|(caller, _)| caller != plugin) {
            return Destination::Failed(MachineFailure::Forbidden);
        }
        match runner.named(id, plugin, note, caller.is_some_and(|(_, server)| server)) {
            Ok(dispatch) => Some(dispatch),
            Err(error) => return Destination::Failed(error),
        }
    } else {
        None
    };
    if let (Some(loaded), Some(target)) = (loaded, target) {
        let manifest = &loaded.catalog.plugins[&target.owner].manifest;
        if let Some((entry_hash, code_hash)) = runner_hashes(manifest) {
            let placement_for = |connection, plugin_machine| RunnerDestination {
                connection,
                plugin_machine,
                plugin: target.owner.clone(),
                entry_hash: entry_hash.to_owned(),
                code_hash: code_hash.to_owned(),
            };
            if let Some(connection) = named {
                let plugin_machine =
                    matches!(selected, ActionTarget::Machine(id) if id.starts_with("machine:"));
                return Destination::ConnectedRunner(placement_for(connection, plugin_machine));
            }
            let Some(auth) = note.auth.as_ref().filter(|auth| auth.is_person()) else {
                return Destination::Failed(MachineFailure::NoMachine);
            };
            match runner.select(auth, note.is_window_continuation()) {
                Selection::Attached(dispatch) => {
                    return Destination::AttachedRunner(placement_for(
                        RunnerConnection {
                            dispatch,
                            stage_plans: true,
                        },
                        false,
                    ));
                }
                Selection::Connected(connection) => {
                    return Destination::ConnectedRunner(placement_for(connection, false));
                }
                Selection::Absent if placement.window => {
                    return Destination::CallerWindowRunner {
                        plugin: target.owner.clone(),
                        entry_hash: entry_hash.to_owned(),
                        code_hash: code_hash.to_owned(),
                    };
                }
                _ => {}
            }
        }
    }

    Destination::Failed(MachineFailure::NoMachine)
}

impl Destination {
    fn runner_destination(&self) -> Option<&RunnerDestination> {
        match self {
            Self::AttachedRunner(route) | Self::ConnectedRunner(route) => Some(route),
            _ => None,
        }
    }

    pub fn context(
        &self,
        note: CallNote,
        runner: Arc<Machines>,
        qualified: Option<String>,
    ) -> (ActionContext, Option<DropGuard>) {
        let lifetime = self.runner_destination().map(|_| CancellationToken::new());
        let guard = lifetime.clone().map(CancellationToken::drop_guard);
        (
            ActionContext {
                note,
                runner,
                lifetime,
                qualified,
                dispatch: self
                    .runner_destination()
                    .map(|route| route.connection.dispatch.clone()),
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
        let qualified = format!("{}/{name}", scope.owner);
        // Reject before running the owner or sending any foreign stage to its machine.
        if let Some(route) = self.runner_destination()
            && let Some(error) = unavailable_hook(&scope.generation, &qualified, |owner, _| {
                route.connection.stage_plans && (!route.plugin_machine || owner == route.plugin)
            })
        {
            return Err(error);
        }
        let Some(target) = HookTarget::load(&scope.generation, &qualified) else {
            return self
                .invoke_owner(process, source, name, args, upstream, None)
                .await
                .map_err(Into::into);
        };
        let note = scope.note.clone();
        let stages = ActionStageExecutor::new(
            &scope.generation,
            &scope.commands,
            &scope.process,
            &scope.runner,
            self.runner_destination()
                .map(|route| route.connection.dispatch.clone()),
            scope.lifetime.clone(),
        );
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
            Self::AttachedRunner(route) | Self::ConnectedRunner(route) => {
                let RunnerDestination {
                    connection,
                    plugin,
                    entry_hash,
                    code_hash,
                    ..
                } = route;
                let dispatch = connection.dispatch;
                let run = |retiring| {
                    dispatch(RunnerAction {
                        plugin,
                        entry_hash,
                        code_hash,
                        name,
                        args,
                        upstream: RunnerActionUpstream::embedded(upstream),
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
    runner: &'a Arc<Machines>,
    dispatch: Option<RunnerDispatch>,
    lifetime: Option<CancellationToken>,
}

impl<'a> ActionStageExecutor<'a> {
    fn new(
        generation: &'a Arc<Loaded>,
        commands: &'a mpsc::WeakSender<Command>,
        process: &'a Arc<Supervisor>,
        runner: &'a Arc<Machines>,
        dispatch: Option<RunnerDispatch>,
        lifetime: Option<CancellationToken>,
    ) -> Self {
        Self {
            generation,
            commands,
            process,
            runner,
            dispatch,
            lifetime,
        }
    }

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
                qualified: None,
                dispatch: None,
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
                        upstream: RunnerActionUpstream::embedded(ops),
                        retiring,
                    })
                })
                .await
        } else {
            self.process
                .invoke_typed(source, name, input, ops.ops)
                .await
        };
        result
            .and_then(|value| {
                if self.dispatch.is_some()
                    && matches!(
                        crate::protocol::failure_kind(&value),
                        Some("machineLost" | "machineForbidden" | "runnerArtifactMismatch")
                    )
                {
                    return Err(runner_action_artifact_unavailable());
                }
                Ok(value)
            })
            .map_err(|error| {
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

pub(crate) fn unavailable_hook(
    loaded: &Loaded,
    name: &str,
    supports: impl Fn(&str, bool) -> bool,
) -> Option<CallError> {
    std::iter::once((name.to_owned(), false))
        .chain(point_targets(loaded, name).map(|(_, point)| (point, true)))
        .find_map(|(target, point)| {
            let hook = loaded
                .hooks
                .get(&target)?
                .iter()
                .find(|hook| !supports(&hook.owner, point))?;
            Some(
                CallError::hook(
                    &hook.owner,
                    &hook.name,
                    if hook.before {
                        "before"
                    } else {
                        "after"
                    },
                    "hookRunnerUnavailable",
                    Json::Null,
                    &target,
                )
                .into(),
            )
        })
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
    pub runner: Arc<Machines>,
    pub lifetime: Option<CancellationToken>,
    pub qualified: Option<String>,
    pub dispatch: Option<RunnerDispatch>,
}

pub(crate) struct NestedCall {
    pub http_root: bool,
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

impl NestedCall {
    async fn send(
        commands: &mpsc::WeakSender<Command>,
        call: Self,
        wait: oneshot::Receiver<Result<Json, CallError>>,
    ) -> Result<Json, CallError> {
        commands
            .upgrade()
            .ok_or("server is closed")?
            .try_send(Command::RunFunction(call))
            .map_err(|e| format!("nested call not admitted: {e}"))?;
        // The coordinator owns finalization once a mutation starts.
        wait.await
            .map_err(|_| "server closed before nested call completed")?
    }
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
    let points =
        register_point_operation(&mut ops, generation.as_ref(), &commands, &process, &context)?;
    context.note.register_points(&mut ops, points)?;
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
    if let (Some(_), Some(owner)) = (&generation, &owner) {
        context
            .runner
            .register_list(&mut ops, owner.clone(), &context.note)?;
        if context.lifetime.is_none() {
            context
                .runner
                .register_management(&mut ops, owner.clone(), context.note.clone())?;
        }
    }
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

struct ActionPoints {
    targets: std::collections::BTreeMap<String, HookTarget>,
    generation: Arc<Loaded>,
    commands: mpsc::WeakSender<Command>,
    process: Arc<Supervisor>,
    context: ActionContext,
}

impl ActionPoints {
    async fn invoke(&self, payload: Json) -> Result<Json, engine::CallError> {
        let target = payload["name"]
            .as_str()
            .and_then(|name| self.targets.get(name))
            .ok_or("Unknown hook point")?;
        let stages = ActionStageExecutor::new(
            &self.generation,
            &self.commands,
            &self.process,
            &self.context.runner,
            self.context.dispatch.clone(),
            self.context.lifetime.clone(),
        );
        run_point(
            target,
            &self.context.note,
            payload,
            |hook, _, note, input| stages.execute(hook, note, input),
        )
        .await
    }
}

fn register_point_operation(
    ops: &mut OpRegistry,
    loaded: Option<&Arc<Loaded>>,
    commands: &mpsc::WeakSender<Command>,
    process: &Arc<Supervisor>,
    context: &ActionContext,
) -> Result<Vec<String>, engine::Error> {
    let (Some(generation), Some(name)) = (loaded, context.qualified.as_deref()) else {
        return Ok(Vec::new());
    };
    let targets: std::collections::BTreeMap<_, _> = point_targets(generation, name)
        .filter_map(|(point, target)| {
            Some((point.to_owned(), HookTarget::load(generation, &target)?))
        })
        .collect();
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let names = targets.keys().cloned().collect();
    let points = Arc::new(ActionPoints {
        targets,
        generation: generation.clone(),
        commands: commands.clone(),
        process: process.clone(),
        context: context.clone(),
    });
    ops.register_call("point.stage", move |payload| {
        let points = points.clone();
        async move { points.invoke(payload).await }
    })?;
    Ok(names)
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
                NestedCall::send(
                    &commands,
                    NestedCall {
                        http_root: false,
                        note,
                        generation,
                        lifetime,
                        owner,
                        name,
                        args,
                        kind,
                        contract: None,
                        reply,
                    },
                    wait,
                )
                .await
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
        ..
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
                return NestedCall::send(
                    &commands,
                    NestedCall {
                        http_root: false,
                        note,
                        generation: Some(loaded),
                        lifetime,
                        owner: Some(owner),
                        name: name.into(),
                        args,
                        kind: target.kind,
                        contract: contract.map(str::to_owned),
                        reply,
                    },
                    wait,
                )
                .await
                .map_err(Into::into);
            }
            if note.is_http() {
                note.check_anonymous_scope(&target, &owner)?;
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
                    qualified: None,
                    dispatch: None,
                },
                args,
                (owner, on),
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
    (caller, on): (String, Option<ActionTarget>),
) -> Result<Json, engine::CallError> {
    let destination = resolve(
        Some(&loaded),
        Some(&target),
        &Placement::new(on, None, None, None),
        Some((&caller, parent.lifetime.is_none())),
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
    let qualified = format!("{}/{}", target.owner, target.local_name);
    let (context, _guard) = destination.context(parent.note, parent.runner, Some(qualified));
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
