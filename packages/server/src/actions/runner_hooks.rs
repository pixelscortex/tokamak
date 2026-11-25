use super::{
    CallNote, Hook, HookTarget, Json, Loaded, point_targets, run_action, run_point, runner_hashes,
};
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    points: BTreeMap<String, PointStages>,
}

#[derive(Serialize, Deserialize)]
struct PointStages {
    args: Json,
    result: Option<Json>,
    hooks: Vec<Hook>,
}

impl RunnerHookPlan {
    pub(super) fn load(loaded: &Loaded, name: &str) -> Option<Self> {
        let target = HookTarget::load(loaded, name);
        let points: BTreeMap<_, _> = point_targets(loaded, name)
            .filter_map(|(point, name)| {
                let target = HookTarget::load(loaded, &name)?;
                Some((
                    point.to_owned(),
                    PointStages {
                        args: (*target.args).clone(),
                        result: target.result.as_deref().cloned(),
                        hooks: target.chain.to_vec(),
                    },
                ))
            })
            .collect();
        if target.is_none() && points.is_empty() {
            return None;
        }
        let hooks = target
            .as_ref()
            .map_or_else(Vec::new, |target| target.chain.to_vec());
        let artifacts = hooks
            .iter()
            .chain(points.values().flat_map(|point| &point.hooks))
            .filter_map(|hook| {
                let (entry, code) = runner_hashes(&loaded.catalog.plugins[&hook.owner].manifest)?;
                Some((
                    hook.owner.clone(),
                    json!({"id":hook.owner,"entryHash":entry,"codeHash":code}),
                ))
            })
            .collect();
        Some(Self {
            name: name.to_owned(),
            args: target
                .as_ref()
                .map_or(Json::Null, |target| (*target.args).clone()),
            result: target
                .as_ref()
                .and_then(|target| target.result.as_deref().cloned()),
            derived: target.is_some_and(|target| target.derived_result_warning.is_some()),
            hooks,
            artifacts,
            points,
        })
    }

    pub fn point_names(&self) -> impl Iterator<Item = &str> {
        self.points.keys().map(String::as_str)
    }

    pub async fn invoke_point<S>(
        &self,
        payload: Json,
        continuation: &Json,
        stage: impl FnMut(Json, String, Json, Json) -> S,
    ) -> Result<Json, engine::CallError>
    where
        S: Future<Output = Result<Json, engine::CallError>>,
    {
        let name = payload["name"].as_str().ok_or("Missing point name")?;
        let point = self.points.get(name).ok_or("Unknown hook point")?;
        let target = HookTarget {
            name: format!("{}#{name}", self.name),
            args: Arc::new(point.args.clone()),
            result: point.result.clone().map(Arc::new),
            derived_result_warning: None,
            chain: point.hooks.clone().into(),
        };
        let note = CallNote::runner_note(continuation);
        run_point(&target, &note, payload, self.executor(stage)).await
    }

    pub async fn invoke<S, O>(
        &self,
        action: &str,
        args: Json,
        continuation: &Json,
        stage: impl FnMut(Json, String, Json, Json) -> S,
        owner: impl FnOnce(Json) -> O,
    ) -> Result<Json, engine::CallError>
    where
        S: Future<Output = Result<Json, engine::CallError>>,
        O: Future<Output = Result<Json, engine::CallError>>,
    {
        if self.name != action {
            return Err("Runner hook plan does not match its action".into());
        }
        if self.hooks.is_empty() {
            return owner(args).await;
        }
        let target = HookTarget {
            name: self.name.clone(),
            args: Arc::new(self.args.clone()),
            result: self.result.clone().map(Arc::new),
            derived_result_warning: self.derived.then(Arc::default),
            chain: self.hooks.clone().into(),
        };
        let note = CallNote::runner_note(continuation);
        run_action(&target, &note, args, self.executor(stage), owner).await
    }

    fn executor<S>(
        &self,
        mut stage: impl FnMut(Json, String, Json, Json) -> S,
    ) -> impl FnMut(Hook, super::Stage, CallNote, Json) -> S {
        move |hook, _, note, input| {
            stage(
                self.artifacts
                    .get(&hook.owner)
                    .cloned()
                    .unwrap_or_else(|| json!({"id":hook.owner})),
                format!("@hook/{}", hook.name),
                input,
                note.continuation(),
            )
        }
    }
}
