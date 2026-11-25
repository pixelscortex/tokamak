use super::*;
use crate::plugins::{Hook, Loaded, Target};
use std::sync::LazyLock;

const PIPELINE: &str = "run";
static ADAPTER: LazyLock<Arc<Bundle>> = LazyLock::new(|| {
    Arc::new(Bundle::new(include_str!("hook_pipeline.js"), None).expect("embedded adapter"))
});

impl TransactionContext {
    async fn check(&self) -> Result<(), String> {
        let observed = self.observations.lock().await;
        let failure = self.failure.lock().expect("failure lock");
        match observed.error.as_ref().or(failure.as_ref()) {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

#[derive(Clone)]
pub(super) struct Plan {
    pub bundle: Arc<Bundle>,
    pub name: String,
    pub export: &'static str,
    pub ops: Arc<OpRegistry>,
}

impl Plan {
    pub(super) async fn submit(self, pool: &Pool, args: Json) -> Result<Json, engine::Error> {
        pool.submit(
            self.bundle,
            self.export,
            json!({"name":self.name,"args":args}),
            self.ops,
        )?
        .await
    }

    pub(super) fn module(
        self,
        args: Json,
        on_error: impl Fn(String) + Send + Sync + 'static,
    ) -> ModuleCall {
        let call = ModuleCall::new(
            self.bundle,
            self.export,
            json!({"name":self.name,"args":args}),
            self.ops,
            on_error,
        );
        if self.export == PIPELINE {
            call.as_adapter()
        } else {
            call
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "the invocation and its transaction are independent"
)]
pub(super) fn plan(
    bundle: Arc<Bundle>,
    name: String,
    space: DataSpace,
    writable: bool,
    graph: Graph,
    qualified: &str,
    tx: TransactionContext,
    context: CallContext,
) -> Plan {
    let hooked = graph.as_ref().and_then(|(plugins, _)| {
        plugins.hooks.get(qualified).map(|hooks| {
            (
                plugins.clone(),
                plugins.targets[qualified].clone(),
                hooks.clone(),
            )
        })
    });
    let note = context.note.clone();
    let determinism = context.determinism;
    let scope = context.scope.clone();
    let plain = Plan {
        bundle,
        name,
        export: "invoke",
        ops: operations(tx.clone(), space, writable, graph, context),
    };

    let Some((plugins, target, hooks)) = hooked else {
        return plain;
    };

    let mut ops = OpRegistry::new();
    if let Some(determinism) = determinism {
        ops.set_determinism(determinism);
    }

    let hooks: Arc<[Hook]> = hooks.into();
    let indexes = |stage: Stage| {
        hooks
            .iter()
            .enumerate()
            .filter_map(|(index, hook)| stage.enabled(hook).then_some(index))
            .collect::<Vec<_>>()
    };
    let before = indexes(Stage::Before);
    let after = indexes(Stage::After);
    let args = target.args.clone();
    let needs_shape = target.result.is_none();
    ops.register_sync("hook.stages", move |input| {
        validate(&args, &input, "args")?;
        Ok(json!({"before":before,"after":after,"needsShape":needs_shape}))
    })
    .expect("unique operation");

    wrap_target(&mut ops, plain, scope, tx.clone());
    for stage in [Stage::Before, Stage::After] {
        register_stage(
            &mut ops,
            stage,
            plugins.clone(),
            target.clone(),
            hooks.clone(),
            qualified,
            note.clone(),
            tx.clone(),
        );
    }

    Plan {
        bundle: ADAPTER.clone(),
        name: qualified.to_owned(),
        export: PIPELINE,
        ops: Arc::new(ops),
    }
}

fn wrap_target(ops: &mut OpRegistry, plain: Plan, scope: CallScope, tx: TransactionContext) {
    ops.register_module("hook.target", move |args| {
        let scope = scope.clone();
        let check = tx.clone();
        let failure = tx.clone();
        Ok(plain
            .clone()
            .module(args, move |error| failure.poison(error))
            .with_scope(async { Ok(()) }, move |(), value| async move {
                scope.close().await;
                check.check().await?;
                Ok(value)
            }))
    })
    .expect("unique operation");
}

#[derive(Clone, Copy)]
enum Stage {
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

#[expect(
    clippy::too_many_arguments,
    reason = "a stage binds the target, hook chain and call context"
)]
fn register_stage(
    ops: &mut OpRegistry,
    stage: Stage,
    plugins: Arc<Loaded>,
    target: Target,
    hooks: Arc<[Hook]>,
    qualified: &str,
    note: CallNote,
    tx: TransactionContext,
) {
    let qualified = qualified.to_owned();
    ops.register_module(format!("hook.{}", stage.name()), move |input| {
        let hook = input["index"]
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| hooks.get(index))
            .ok_or("Invalid hook stage index")?;
        let label = format!(
            "Hook {}/{} ({qualified} {})",
            hook.owner,
            hook.name,
            stage.name()
        );
        let note = note.enter(&label, Some(&target.args), &input["args"])?;
        let scope = CallScope::default();

        let ops = operations(
            tx.clone(),
            hook.space.clone(),
            false,
            Some((plugins.clone(), hook.owner.clone())),
            CallContext {
                determinism: None,
                note,
                scope: scope.clone(),
            },
        );
        let check = tx.clone();
        let failure = tx.clone();
        let failed_hook = label.clone();
        let validator = match stage {
            Stage::Before => Some(target.args.clone()),
            Stage::After => target.result.clone(),
        };

        Ok(ModuleCall::new(
            hook.bundle.clone(),
            "invoke_hook",
            json!({
                "name":hook.name,
                "stage":stage.name(),
                "args":input["args"],
                "result":input["result"],
            }),
            ops,
            move |error| {
                failure
                    .failed_hook
                    .lock()
                    .expect("hook failure lock")
                    .get_or_insert_with(|| failed_hook.clone());
                failure.poison(error);
            },
        )
        .with_error_context(label)
        .with_scope(async { Ok(()) }, move |(), value| async move {
            scope.close().await;
            check.check().await?;

            if let Stage::Before = stage
                && let Some(kind) = failure_kind(&value)
            {
                let data = &value["data"];
                return Err(if data.is_null() {
                    kind.to_owned()
                } else {
                    format!("{kind}: {data}")
                });
            }

            let path = match stage {
                Stage::Before => "args",
                Stage::After => "result",
            };
            match validator {
                Some(validator) => validate(&validator, &value, path)?,
                None if same_shape(&input["original"], &value) => {}
                None => return Err("result does not match the target's result shape".into()),
            }
            Ok(value)
        }))
    })
    .expect("unique operation");
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

fn same_shape(original: &Json, result: &Json) -> bool {
    match (original, result) {
        (Json::Object(original), Json::Object(result)) => {
            original.len() == result.len()
                && result
                    .iter()
                    .all(|(key, value)| original.get(key).is_some_and(|old| same_shape(old, value)))
        }
        (Json::Array(original), Json::Array(result)) => result
            .iter()
            .all(|value| original.iter().any(|old| same_shape(old, value))),
        _ => std::mem::discriminant(original) == std::mem::discriminant(result),
    }
}
