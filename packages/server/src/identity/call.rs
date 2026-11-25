use super::AuthContext;
use crate::data::Id;
pub(crate) use engine::HookBudget;
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) struct CallDepthLimit(String);

impl std::fmt::Display for CallDepthLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<CallDepthLimit> for engine::CallError {
    fn from(error: CallDepthLimit) -> Self {
        Self {
            message: error.0,
            details: None,
            limit: Some(engine::CallLimit::Depth),
            kind: None,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct CallNote {
    pub auth: Option<AuthContext>,
    thread_id: Option<String>,
    depth: usize,
    window_continuation: bool,
    hooks: HookBudget,
    hook_scope: Option<u64>,
    in_trigger: bool,
}

impl From<Option<AuthContext>> for CallNote {
    fn from(auth: Option<AuthContext>) -> Self {
        Self {
            auth,
            ..Self::default()
        }
    }
}

impl CallNote {
    pub fn from_local_parent(
        auth: &AuthContext,
        depth: usize,
        thread_id: Option<String>,
    ) -> Result<Self, String> {
        if let Some(thread_id) = &thread_id
            && !(thread_id.starts_with(tokamak_worker::CHAT_THREAD_ID_PREFIX)
                && thread_id
                    .split_once('/')
                    .is_some_and(|(_, id)| id.parse::<Id>().is_ok()))
        {
            return Err("Invalid local call thread ID".into());
        }

        Ok(Self {
            auth: Some(auth.clone()),
            thread_id,
            depth,
            window_continuation: true,
            ..Self::default()
        })
    }

    pub(crate) fn runner_note(value: &Value) -> Self {
        Self {
            depth: value["depth"]
                .as_u64()
                .unwrap_or_default()
                .min(tokamak_worker::MAX_CALL_DEPTH as u64) as usize,
            thread_id: value["thread"].as_str().map(str::to_owned),
            hook_scope: value["hookScope"].as_u64(),
            ..Self::default()
        }
    }

    pub(crate) fn hook_scope(&self) -> Option<u64> {
        self.hook_scope
    }

    pub(crate) fn scope_hooks(&mut self, id: u64, budget: HookBudget) {
        self.hook_scope = Some(id);
        self.hooks = budget;
    }

    pub(crate) fn take_hook_stage(&self) -> bool {
        self.hooks.take()
    }

    pub(crate) fn hook_budget(&self) -> HookBudget {
        self.hooks.clone()
    }

    pub(crate) fn trigger_stage(mut self) -> Self {
        if !self.in_trigger {
            // A bulk save starts a fresh budget for each outer trigger dispatch.
            // The scope is discarded with the dispatch, including on retry.
            self.hooks = HookBudget::default();
            self.in_trigger = true;
        }
        self
    }

    pub(crate) fn mutation_attempt(&self) -> Self {
        Self {
            hooks: self.hooks.attempt(),
            ..self.clone()
        }
    }

    pub(crate) fn retry_hooks(&self) {
        self.hooks.refund_attempt();
    }

    pub fn enter(
        &self,
        name: &str,
        validator: Option<&Value>,
        args: &Value,
    ) -> Result<Self, CallDepthLimit> {
        let depth = tokamak_worker::next_call_depth(self.depth, name).map_err(CallDepthLimit)?;
        let mut note = self.clone();
        note.depth = depth;
        Ok(note.with_args(validator, args))
    }

    pub fn with_root_args(self, validator: &Value, args: &Value) -> Self {
        if self.depth == 0 {
            self.with_args(Some(validator), args)
        } else {
            self
        }
    }

    fn with_args(mut self, validator: Option<&Value>, args: &Value) -> Self {
        if self.thread_id.is_none() {
            self.thread_id = validator
                .and_then(|schema| thread_in(schema, args).ok().flatten())
                .map(str::to_owned);
        }
        self
    }

    pub fn is_window_continuation(&self) -> bool {
        self.window_continuation
    }

    pub fn continuation(&self) -> Value {
        let mut value = json!({"depth": self.depth, "thread": self.thread_id});
        if let Some(scope) = self.hook_scope {
            value["hookScope"] = json!(scope);
        }
        value
    }

    pub fn register(&self, ops: &mut engine::OpRegistry) -> Result<(), engine::Error> {
        self.register_points(ops, Vec::new())
    }

    pub(crate) fn register_points(
        &self,
        ops: &mut engine::OpRegistry,
        points: Vec<String>,
    ) -> Result<(), engine::Error> {
        let user = json!(self.auth.as_ref().map(|auth| &auth.user));
        ops.register_sync("user.current", move |_| Ok(user.clone()))?;
        let auth = json!(self.auth);
        let mut note = json!({
            "user": auth["user"],
            "device": auth["device"],
            "depth": self.depth,
        });
        if let Some(thread_id) = &self.thread_id {
            note["threadId"] = json!(thread_id);
        }
        if !points.is_empty() {
            note["hookPoints"] = json!(points);
        }
        ops.register_sync("auth.current", move |payload| {
            Ok(if payload["call"] == true {
                note.clone()
            } else {
                auth.clone()
            })
        })
    }
}

fn thread_in<'a>(schema: &Value, value: &'a Value) -> Result<Option<&'a str>, ()> {
    match schema["kind"].as_str().ok_or(())? {
        "optional" => thread_in(&schema["inner"], value),
        "object" => {
            let fields = schema["fields"].as_object().ok_or(())?;
            let object = value.as_object().ok_or(())?;
            if object.keys().any(|key| !fields.contains_key(key)) {
                return Err(());
            }
            let mut first = None;
            for (name, field) in fields {
                if let Some(value) = object.get(name) {
                    let thread = thread_in(field, value)?;
                    first = first.or(thread);
                } else if field["kind"] != "optional" {
                    return Err(());
                }
            }
            Ok(first)
        }
        "array" => {
            let mut first = None;
            for item in value.as_array().ok_or(())? {
                let thread = thread_in(&schema["item"], item)?;
                first = first.or(thread);
            }
            Ok(first)
        }
        "union" => schema["members"]
            .as_array()
            .ok_or(())?
            .iter()
            .find_map(|member| thread_in(member, value).ok())
            .ok_or(()),
        "id" => {
            let id = value.as_str().ok_or(())?;
            let logical = id.split_once('/').map_or(id, |(_, logical)| logical);
            let parsed: Id = logical.parse().map_err(|_| ())?;
            if schema["table"] != parsed.table().as_str() {
                return Err(());
            }
            Ok((id.starts_with(tokamak_worker::CHAT_THREAD_ID_PREFIX)).then_some(id))
        }
        "string" if value.is_string() => Ok(None),
        "number" if value.is_number() => Ok(None),
        "boolean" if value.is_boolean() => Ok(None),
        "null" if value.is_null() => Ok(None),
        "literal" if crate::data::json_equal(value, &schema["value"]) => Ok(None),
        "any" => Ok(None),
        "string" | "number" | "boolean" | "null" | "literal" => Err(()),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_arguments_match_the_sdk_cases() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../sdk/tests/fixtures/thread-arguments.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                thread_in(&case["schema"], &case["args"]),
                Ok(case["thread"].as_str()),
                "{}",
                case["name"]
            );
        }
    }
}
