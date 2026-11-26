use super::*;
use crate::{
    plugins::{Hook, Loaded},
    protocol::CallError,
};
use engine::{CallFuture, CallTransforms, StageExecutor};

pub(crate) type HookRegistry = std::collections::BTreeMap<String, Arc<[Hook]>>;

pub(crate) struct HookTarget {
    pub name: String,
    pub args: Arc<Json>,
    pub result: Option<Arc<Json>>,
    pub chain: Arc<[Hook]>,
    pub derived_result_warning: Option<Arc<std::sync::atomic::AtomicBool>>,
}

impl HookTarget {
    pub fn load(plugins: &Loaded, name: &str) -> Option<Self> {
        let chain = plugins.hooks.get(name)?.clone();
        if let Some((function, point)) = name.split_once('#') {
            let point = plugins.targets.get(function)?.points.get(point)?;
            return Some(Self {
                name: name.to_owned(),
                args: Arc::new(point.args.clone()),
                result: point.result.clone().map(Arc::new),
                chain,
                derived_result_warning: None,
            });
        }
        let target = &plugins.targets[name];
        Some(Self {
            name: name.to_owned(),
            args: target.args.clone(),
            result: target.result.clone(),
            chain,
            derived_result_warning: target.derived_result_warning.clone(),
        })
    }
}

pub(crate) fn point_targets<'a>(
    plugins: &'a Loaded,
    name: &str,
) -> impl Iterator<Item = (&'a str, String)> {
    let prefix = format!("{name}#");
    plugins
        .hooks
        .range(prefix.clone()..)
        .map_while(move |(target, _)| {
            target
                .strip_prefix(&prefix)
                .map(|point| (point, target.clone()))
        })
}

pub(crate) async fn run_point<F: Future<Output = Result<Json, engine::CallError>>>(
    target: &HookTarget,
    note: &CallNote,
    mut payload: Json,
    execute: impl FnMut(Hook, Stage, CallNote, Json) -> F,
) -> Result<Json, engine::CallError> {
    match payload["stage"].as_str() {
        Some("before") => run_before(target, note, payload["args"].take(), execute).await,
        Some("collect") if target.result.is_none() => {
            let args = payload["args"].take();
            validate(&target.args, &args, "args")?;
            run_chain(
                target,
                note,
                ChainStage {
                    stage: Stage::Before,
                    validation: Some(&target.args),
                    collect: true,
                },
                Json::Null,
                &args,
                execute,
            )
            .await
        }
        Some("after") if target.result.is_some() => {
            let result = payload["result"].take();
            run_after(target, note, result, &payload["args"], execute).await
        }
        _ => Err("Invalid point stage".into()),
    }
}

pub(super) fn register_point_operations(
    ops: &mut OpRegistry,
    tx: &TransactionContext,
    graph: &Graph,
    context: &CallContext,
) {
    let points: std::collections::BTreeMap<_, _> = graph
        .as_ref()
        .zip(context.qualified.as_deref())
        .into_iter()
        .flat_map(|((plugins, _), name)| {
            point_targets(plugins, name).filter_map(|(name, target)| {
                Some((
                    name.to_owned(),
                    TransactionHooks::for_target(plugins, Some(target), &context.note, tx)?,
                ))
            })
        })
        .collect();
    context
        .note
        .register_points(ops, points.keys().cloned().collect())
        .expect("unique operation");
    if points.is_empty() {
        return;
    }
    let points = Arc::new(points);
    let scope = context.scope.clone();
    ops.register_staged("point.stage", move |executor, payload| {
        let points = points.clone();
        let scope = scope.clone();
        Box::pin(async move {
            let _guard = scope.enter().await?;
            let target = payload["name"]
                .as_str()
                .and_then(|name| points.get(name))
                .ok_or("Unknown hook point")?;
            let result = run_point(
                &target.target,
                &target.note,
                payload,
                |hook, stage, note, input| target.execute(executor, hook, stage, note, input),
            )
            .await;
            target.finish(result)
        })
    })
    .expect("unique operation");
}

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    Before,
    After,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
        }
    }

    fn enabled(self, hook: &Hook) -> bool {
        match self {
            Self::Before => hook.before,
            Self::After => hook.after,
        }
    }
}

pub(crate) async fn run_before<F: Future<Output = Result<Json, engine::CallError>>>(
    target: &HookTarget,
    note: &CallNote,
    args: Json,
    execute: impl FnMut(Hook, Stage, CallNote, Json) -> F,
) -> Result<Json, engine::CallError> {
    validate(&target.args, &args, "args")?;
    run_chain(
        target,
        note,
        ChainStage {
            stage: Stage::Before,
            validation: Some(&target.args),
            collect: false,
        },
        args,
        &Json::Null,
        execute,
    )
    .await
}

pub(crate) async fn run_after<F: Future<Output = Result<Json, engine::CallError>>>(
    target: &HookTarget,
    note: &CallNote,
    result: Json,
    args: &Json,
    execute: impl FnMut(Hook, Stage, CallNote, Json) -> F,
) -> Result<Json, engine::CallError> {
    let mut validation = target.result.as_deref();
    if let (Some(warning), Some(schema)) = (&target.derived_result_warning, validation)
        && target.chain.iter().any(|hook| hook.after)
        && validate(schema, &result, "result").is_err()
    {
        validation = None;
        if !warning.swap(true, std::sync::atomic::Ordering::Relaxed) {
            eprintln!(
                "Hook target {} returned a result outside its derived validator; accepting its after-hook results for this call",
                target.name
            );
        }
    }
    run_chain(
        target,
        note,
        ChainStage {
            stage: Stage::After,
            validation,
            collect: false,
        },
        result,
        args,
        execute,
    )
    .await
}

struct ChainStage<'a> {
    stage: Stage,
    validation: Option<&'a Json>,
    collect: bool,
}

async fn run_chain<F: Future<Output = Result<Json, engine::CallError>>>(
    target: &HookTarget,
    note: &CallNote,
    ChainStage {
        stage,
        validation,
        collect,
    }: ChainStage<'_>,
    mut value: Json,
    args: &Json,
    mut execute: impl FnMut(Hook, Stage, CallNote, Json) -> F,
) -> Result<Json, engine::CallError> {
    let mut contributions = Vec::new();
    for hook in target.chain.iter().filter(|hook| stage.enabled(hook)) {
        let stage_args = if !collect && matches!(stage, Stage::Before) {
            &value
        } else {
            args
        };
        let make_error = |kind: &str, data| {
            CallError::hook(
                &hook.owner,
                &hook.name,
                if collect {
                    "collect"
                } else {
                    stage.name()
                },
                kind,
                data,
                &target.name,
            )
        };
        let note = note
            .enter(&target.name, Some(&target.args), stage_args)
            .map_err(|_| make_error("hookDepthLimit", json!("plugin call cycle or depth limit")))?;
        if !note.take_hook_stage() {
            return Err(make_error(
                "hookDepthLimit",
                json!("delegated module count budget exceeded"),
            ));
        }
        let input = match stage {
            Stage::Before => {
                json!({"name":hook.name,"target":target.name,"stage":"before","args":stage_args})
            }
            Stage::After => {
                json!({"name":hook.name,"target":target.name,"stage":"after","args":args,"result":value})
            }
        };
        value = execute(hook.clone(), stage, note, input)
            .await
            .map_err(|error| hook_stage_error(error, make_error))?;

        // Runner capability failures mean the stage could not run, even in an after hook.
        if let Some(kind) = failure_kind(&value)
            && (matches!(stage, Stage::Before)
                || matches!(kind, "runnerCapabilityUnavailable" | "noMachine"))
        {
            return Err(make_error(kind, value["data"].clone()));
        }

        if let Some(schema) = validation {
            let path = if matches!(stage, Stage::Before) {
                "args"
            } else {
                "result"
            };
            validate(schema, &value, path)
                .map_err(|message| make_error("invalidHookResult", json!(message)))?;
        }
        if collect {
            contributions.push(json!({"plugin":hook.owner,"value":value.take()}));
        }
    }
    Ok(if collect {
        Json::Array(contributions)
    } else {
        value
    })
}

fn hook_stage_error(
    error: engine::CallError,
    make_error: impl FnOnce(&str, Json) -> engine::CallError,
) -> engine::CallError {
    if error.kind == Some(engine::CallErrorKind::RunnerArtifactUnavailable) {
        return make_error("hookRunnerUnavailable", Json::Null);
    }
    if error.details.is_some() {
        return error;
    }
    match error.limit {
        Some(engine::CallLimit::Depth) => {
            make_error("hookDepthLimit", json!("plugin call cycle or depth limit"))
        }
        Some(engine::CallLimit::Modules) => make_error(
            "hookDepthLimit",
            json!("delegated module count budget exceeded"),
        ),
        None => {
            let message = error.message.lines().next().unwrap_or_default();
            make_error("hookException", json!(message))
        }
    }
}

pub(super) struct TransactionHooks {
    target: HookTarget,
    plugins: Arc<Loaded>,
    note: CallNote,
    tx: TransactionContext,
    writable: bool,
}

impl TransactionHooks {
    pub(super) fn for_target(
        plugins: &Arc<Loaded>,
        name: Option<String>,
        note: &CallNote,
        tx: &TransactionContext,
    ) -> Option<Self> {
        let name = name?;
        Some(Self {
            target: HookTarget::load(plugins, &name)?,
            plugins: plugins.clone(),
            note: note.clone(),
            tx: tx.clone(),
            writable: plugins.targets[name
                .split_once('#')
                .map_or(name.as_str(), |(function, _)| function)]
            .mutation,
        })
    }

    async fn execute(
        &self,
        executor: &dyn StageExecutor,
        hook: Hook,
        stage: Stage,
        note: CallNote,
        input: Json,
    ) -> Result<Json, engine::CallError> {
        let (owner, name, target) = (
            hook.owner.clone(),
            hook.name.clone(),
            self.target.name.clone(),
        );
        let label = Arc::new(move || {
            CallError::hook(
                &owner,
                &name,
                stage.name(),
                "hookTimeout",
                Json::Null,
                &target,
            )
        });
        execute_stage(
            executor,
            &self.tx,
            &self.plugins,
            StageCall {
                owner: &hook.owner,
                kind: if self.writable {
                    StageKind::MutationHook
                } else {
                    StageKind::QueryHook
                },
                note,
                input,
                label,
            },
        )
        .await
    }
    fn finish(&self, result: Result<Json, engine::CallError>) -> Result<Json, engine::CallError> {
        if self.writable
            && let Err(error) = &result
        {
            self.tx.poison(error.clone());
        }
        result
    }
}

pub(super) enum StageKind {
    QueryHook,
    MutationHook,
    Trigger,
}

pub(super) struct StageCall<'a> {
    pub owner: &'a str,
    pub kind: StageKind,
    pub note: CallNote,
    pub input: Json,
    pub label: TimeoutLabel,
}

pub(super) async fn execute_stage(
    executor: &dyn StageExecutor,
    parent: &TransactionContext,
    plugins: &Arc<Loaded>,
    stage: StageCall<'_>,
) -> Result<Json, engine::CallError> {
    let (export, writable) = match stage.kind {
        StageKind::QueryHook => ("invoke_hook", false),
        StageKind::MutationHook => ("invoke_hook", true),
        StageKind::Trigger => ("invoke_trigger", true),
    };
    let budget = stage.note.hook_budget();
    let scope = CallScope::default();
    let tx = parent.stage_scope();
    let ops = operations(
        tx.clone(),
        DataSpace::plugin(stage.owner).map_err(|error| error.to_string())?,
        writable,
        Some((plugins.clone(), stage.owner.to_owned())),
        CallContext {
            determinism: None,
            note: stage.note,
            scope: scope.clone(),
            qualified: None,
        },
    );

    let label = stage.label;
    let active = &parent.active_stages;
    active
        .lock()
        .expect("active stages lock")
        .push(label.clone());

    let call = ModuleCall::new(
        plugins.transaction_bundles[stage.owner].clone(),
        export,
        stage.input,
        ops,
        |_| {},
    );
    let value = executor.run(call, budget).await;

    active
        .lock()
        .expect("active stages lock")
        .retain(|entry| !Arc::ptr_eq(entry, &label));
    scope.close().await;
    let observed = tx.observations.lock().await;
    if observed.conflict {
        parent.observations.lock().await.conflict = true;
    }
    let failure = tx.failure.lock().expect("failure lock");
    if let Some(error) = &observed.error {
        Err(error.clone().into())
    } else if let Some(error) = failure.as_ref() {
        Err(error.clone())
    } else {
        value
    }
}

impl CallTransforms for TransactionHooks {
    fn before<'a>(&'a self, executor: &'a dyn StageExecutor, mut input: Json) -> CallFuture<'a> {
        Box::pin(async move {
            let args = run_before(
                &self.target,
                &self.note,
                input["args"].take(),
                |hook, stage, note, input| self.execute(executor, hook, stage, note, input),
            )
            .await;
            input["args"] = self.finish(args)?;
            Ok(input)
        })
    }

    fn after<'a>(
        &'a self,
        executor: &'a dyn StageExecutor,
        input: Json,
        value: Json,
    ) -> CallFuture<'a> {
        Box::pin(async move {
            if self.writable && failure_kind(&value).is_some() {
                return Ok(value);
            }
            let result = run_after(
                &self.target,
                &self.note,
                value,
                &input["args"],
                |hook, stage, note, input| self.execute(executor, hook, stage, note, input),
            )
            .await;
            self.finish(result)
        })
    }
}

fn validate(schema: &Json, value: &Json, path: &str) -> Result<(), String> {
    let expected = schema["kind"].as_str().unwrap_or("validator");
    let valid = match expected {
        "any" => true,
        "optional" => return validate(&schema["inner"], value, path),
        "union" => schema["members"].as_array().is_some_and(|members| {
            members
                .iter()
                .any(|schema| validate(schema, value, path).is_ok())
        }),
        "object" => {
            let (Some(fields), Some(object)) = (schema["fields"].as_object(), value.as_object())
            else {
                return Err(format!("{path}: expected object"));
            };
            for (name, value) in object {
                let field = fields
                    .get(name)
                    .ok_or_else(|| format!("{path}.{name}: unexpected field"))?;
                validate(field, value, &format!("{path}.{name}"))?;
            }
            for (name, field) in fields {
                if field["kind"] != "optional" && !object.contains_key(name) {
                    return Err(format!("{path}.{name}: required field is missing"));
                }
            }
            true
        }
        "tuple" => return validate_tuple(schema, value, path),
        "array" => {
            let Some(array) = value.as_array() else {
                return Err(format!("{path}: expected array"));
            };
            for (index, item) in array.iter().enumerate() {
                validate(&schema["item"], item, &format!("{path}[{index}]"))?;
            }
            true
        }
        "string" => value.is_string(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "literal" => json_equal(value, &schema["value"]),
        "id" => value.as_str().is_some_and(|value| {
            let logical = match value.split_once('/') {
                Some((namespace, logical)) if DataSpace::plugin(namespace).is_ok() => logical,
                Some(_) => return false,
                None => value,
            };
            logical
                .parse::<data::Id>()
                .is_ok_and(|id| schema["table"] == id.table().as_str())
        }),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("{path}: expected {expected}"))
    }
}

fn validate_tuple(schema: &Json, value: &Json, path: &str) -> Result<(), String> {
    let (Some(items), Some(values)) = (schema["items"].as_array(), value.as_array()) else {
        return Err(format!("{path}: expected tuple"));
    };
    let mut index = 0;
    for (position, item) in items.iter().enumerate() {
        if item["rest"] == true {
            let trailing = items.len() - position - 1;
            while index + trailing < values.len() {
                validate(&item["value"], &values[index], &format!("{path}[{index}]"))?;
                index += 1;
            }
        } else if let Some(value) = values.get(index) {
            validate(&item["value"], value, &format!("{path}[{index}]"))?;
            index += 1;
        } else if item["optional"] != true {
            return Err(format!("{path}[{index}]: required tuple item is missing"));
        }
    }
    if index != values.len() {
        return Err(format!("{path}: unexpected tuple items"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn collect_uses_original_args_and_attributes_each_result() {
        let target = HookTarget {
            name: "ai/run:turn#launch".into(),
            args: Arc::new(json!({"kind": "string"})),
            result: None,
            chain: ["first", "second"]
                .map(|owner| Hook {
                    owner: owner.into(),
                    name: "launch".into(),
                    before: true,
                    after: true,
                })
                .into(),
            derived_result_warning: None,
        };
        let value = run_point(
            &target,
            &CallNote::default(),
            json!({"stage": "collect", "args": "original"}),
            |hook, stage, _, input| {
                assert!(matches!(stage, Stage::Before));
                assert_eq!(input["args"], "original");
                std::future::ready(Ok(json!(hook.owner)))
            },
        )
        .await
        .unwrap();
        assert_eq!(
            value,
            json!([
                {"plugin": "first", "value": "first"},
                {"plugin": "second", "value": "second"},
            ])
        );

        let error = run_point(
            &target,
            &CallNote::default(),
            json!({"stage": "collect", "args": "original"}),
            |_, _, _, _| std::future::ready(Ok(Json::Null)),
        )
        .await
        .unwrap_err();
        let details = error.details.unwrap();
        assert_eq!(details["stage"], "pointBefore");
        assert_eq!(details["plugin"], "first");
    }
}
