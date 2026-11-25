use super::{CallNote, Hook, HookTarget, Json, Loaded, run_action, runner_hashes};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, future::Future, sync::Arc};

/// A window transfers this plan with the selected action to its Runner.
#[derive(Serialize, Deserialize)]
pub struct RunnerHookPlan {
    name: String,
    args: Json,
    result: Option<Json>,
    derived: bool,
    hooks: Vec<Hook>,
    artifacts: BTreeMap<String, Json>,
}

impl RunnerHookPlan {
    pub(super) fn load(loaded: &Loaded, name: &str) -> Option<Self> {
        let target = HookTarget::load(loaded, name)?;
        let artifacts = target
            .chain
            .iter()
            .filter_map(|hook| {
                let (entry, code) = runner_hashes(&loaded.catalog.plugins[&hook.owner].manifest)?;
                Some((
                    hook.owner.clone(),
                    json!({"id":hook.owner,"entryHash":entry,"codeHash":code}),
                ))
            })
            .collect();
        Some(Self {
            name: target.name,
            args: (*target.args).clone(),
            result: target.result.as_deref().cloned(),
            derived: target.derived_result_warning.is_some(),
            hooks: target.chain.to_vec(),
            artifacts,
        })
    }

    pub async fn invoke<S, O>(
        self,
        action: &str,
        args: Json,
        continuation: &Json,
        mut stage: impl FnMut(Json, String, Json, Json) -> S,
        owner: impl FnOnce(Json) -> O,
    ) -> Result<Json, engine::CallError>
    where
        S: Future<Output = Result<Json, engine::CallError>>,
        O: Future<Output = Result<Json, engine::CallError>>,
    {
        if self.name != action {
            return Err("Runner hook plan does not match its action".into());
        }
        let target = HookTarget {
            name: self.name,
            args: Arc::new(self.args),
            result: self.result.map(Arc::new),
            derived_result_warning: self.derived.then(Arc::default),
            chain: self.hooks.into(),
        };
        let note = CallNote::runner_note(continuation);
        let execute = |hook: Hook, _, note: CallNote, input| {
            stage(
                self.artifacts
                    .get(&hook.owner)
                    .cloned()
                    .unwrap_or_else(|| json!({"id":hook.owner})),
                format!("@hook/{}", hook.name),
                input,
                note.continuation(),
            )
        };

        run_action(&target, &note, args, execute, owner).await
    }
}
