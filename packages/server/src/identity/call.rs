use super::AuthContext;
use serde_json::{Value, json};

#[derive(Clone, Default)]
pub(crate) struct CallNote {
    pub auth: Option<AuthContext>,
    thread_id: Option<String>,
    depth: usize,
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
    pub fn nested(mut self, name: &str) -> Result<Self, String> {
        self.depth = tokamak_worker::next_call_depth(self.depth, name)?;
        Ok(self)
    }

    pub fn with_args(mut self, validator: &Value, args: &Value) -> Self {
        if self.thread_id.is_none() {
            self.thread_id = thread_in(validator, args).ok().flatten().map(str::to_owned);
        }
        self
    }

    pub fn register(&self, ops: &mut engine::OpRegistry) -> Result<(), engine::Error> {
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
            let (namespace, logical) = id
                .split_once('/')
                .map_or((None, id), |(ns, id)| (Some(ns), id));
            let parsed: crate::data::Id = logical.parse().map_err(|_| ())?;
            if schema["table"] != parsed.table().as_str() {
                return Err(());
            }
            Ok((parsed.table().as_str() == "threads" && namespace == Some("chat")).then_some(id))
        }
        "string" if value.is_string() => Ok(None),
        "number" if value.is_number() => Ok(None),
        "boolean" if value.is_boolean() => Ok(None),
        "null" if value.is_null() => Ok(None),
        "literal" if crate::data::json_equal(value, &schema["value"]) => Ok(None),
        "any" => Ok(None),
        _ => Err(()),
    }
}
