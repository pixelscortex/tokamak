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

pub(crate) async fn run_before(
    target: &HookTarget,
    note: &CallNote,
    args: Json,
    execute: impl AsyncFnMut(&Hook, Stage, CallNote, Json) -> Result<Json, engine::CallError>,
) -> Result<Json, engine::CallError> {
    validate(&target.args, &args, "args")?;
    run_chain(
        target,
        note,
        ChainStage {
            stage: Stage::Before,
            validation: Some(&target.args),
        },
        args,
        &Json::Null,
        execute,
    )
    .await
}

pub(crate) async fn run_after(
    target: &HookTarget,
    note: &CallNote,
    result: Json,
    args: &Json,
    execute: impl AsyncFnMut(&Hook, Stage, CallNote, Json) -> Result<Json, engine::CallError>,
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
}

async fn run_chain(
    target: &HookTarget,
    note: &CallNote,
    ChainStage { stage, validation }: ChainStage<'_>,
    mut value: Json,
    args: &Json,
    mut execute: impl AsyncFnMut(&Hook, Stage, CallNote, Json) -> Result<Json, engine::CallError>,
) -> Result<Json, engine::CallError> {
    for hook in target.chain.iter().filter(|hook| stage.enabled(hook)) {
        let stage_args = if matches!(stage, Stage::Before) {
            &value
        } else {
            args
        };
        let make_error = |kind: &str, data| {
            CallError::hook(
                &hook.owner,
                &hook.name,
                stage.name(),
                kind,
                data,
                &target.name,
            )
        };
        let note = note
            .enter(&target.name, Some(&target.args), stage_args)
            .map_err(|_| make_error("hookDepthLimit", json!("plugin call cycle or depth limit")))?;
        let input = match stage {
            Stage::Before => json!({"name":hook.name,"stage":"before","args":value}),
            Stage::After => json!({"name":hook.name,"stage":"after","args":args,"result":value}),
        };
        value = execute(hook, stage, note, input).await.map_err(|error| {
            if error.details.is_some() {
                error
            } else {
                match error.limit {
                    Some(engine::CallLimit::Depth) => {
                        make_error("hookDepthLimit", json!("plugin call cycle or depth limit"))
                    }
                    Some(engine::CallLimit::Modules) => make_error(
                        "hookDepthLimit",
                        json!("delegated module count budget exceeded"),
                    ),
                    None => {
                        let message = error.message.split("\n    at ").next().unwrap_or_default();
                        make_error("hookException", json!(message))
                    }
                }
            }
        })?;

        if matches!(stage, Stage::Before)
            && let Some(kind) = failure_kind(&value)
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
    }
    Ok(value)
}

pub(super) struct QueryHooks {
    target: HookTarget,
    plugins: Arc<Loaded>,
    note: CallNote,
    tx: TransactionContext,
}

impl QueryHooks {
    pub(super) fn for_target(
        plugins: &Arc<Loaded>,
        name: Option<String>,
        note: &CallNote,
        tx: &TransactionContext,
    ) -> Option<Self> {
        let name = name?;
        let chain = plugins.query_hooks.get(&name)?.clone();
        let target = &plugins.targets[&name];
        Some(Self {
            target: HookTarget {
                name,
                args: target.args.clone(),
                result: target.result.clone(),
                chain,
                derived_result_warning: target.derived_result_warning.clone(),
            },
            plugins: plugins.clone(),
            note: note.clone(),
            tx: tx.clone(),
        })
    }

    async fn execute(
        &self,
        executor: &dyn StageExecutor,
        hook: &Hook,
        stage: Stage,
        note: CallNote,
        input: Json,
    ) -> Result<Json, engine::CallError> {
        let scope = CallScope::default();
        let tx = self.tx.hook_scope();
        let ops = operations(
            tx.clone(),
            hook.space.clone(),
            false,
            Some((self.plugins.clone(), hook.owner.clone())),
            CallContext {
                determinism: None,
                note,
                scope: scope.clone(),
                qualified: None,
            },
        );
        let label = Arc::new(CallError::hook(
            &hook.owner,
            &hook.name,
            stage.name(),
            "hookTimeout",
            Json::Null,
            &self.target.name,
        ));
        let call = ModuleCall::new(hook.bundle.clone(), "invoke_hook", input, ops, |_| {});
        let active = &self.tx.active_hooks;
        active
            .lock()
            .expect("active hooks lock")
            .push(label.clone());
        let value = executor.run(call).await;
        active
            .lock()
            .expect("active hooks lock")
            .retain(|entry| !Arc::ptr_eq(entry, &label));
        scope.close().await;
        let observed = tx.observations.lock().await;
        let failure = tx.failure.lock().expect("failure lock");
        if let Some(error) = &observed.error {
            Err(error.clone().into())
        } else if let Some(error) = failure.as_ref() {
            Err(error.clone())
        } else {
            value
        }
    }
}

impl CallTransforms for QueryHooks {
    fn before<'a>(&'a self, executor: &'a dyn StageExecutor, mut input: Json) -> CallFuture<'a> {
        Box::pin(async move {
            input["args"] = run_before(
                &self.target,
                &self.note,
                input["args"].take(),
                async |hook, stage, note, input| {
                    self.execute(executor, hook, stage, note, input).await
                },
            )
            .await?;
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
            run_after(
                &self.target,
                &self.note,
                value,
                &input["args"],
                async |hook, stage, note, input| {
                    self.execute(executor, hook, stage, note, input).await
                },
            )
            .await
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
