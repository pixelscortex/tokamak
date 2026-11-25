//! The single wire contract for native and WebSocket clients. `export-protocol`
//! generates SDK types from these serde types; neither transport invents events.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

// Keep this wire shape in sync with the SDK's isFailure guard.
pub(crate) fn failure_kind(value: &Json) -> Option<&str> {
    if value.get("failed")?.as_bool()? && value.get("data").is_some() {
        value.get("kind")?.as_str()
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CallError {
    Message(String),
    Structured(Box<StructuredCallError>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StructuredCallError {
    pub message: String,
    #[serde(flatten)]
    pub details: CallErrorDetails,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "protocol-codegen", derive(ts_rs::TS))]
pub struct CallErrorDetails {
    pub plugin: String,
    pub hook: String,
    pub stage: String,
    pub kind: String,
    #[cfg_attr(feature = "protocol-codegen", ts(type = "JsonValue"))]
    pub data: Json,
}

impl CallError {
    pub(crate) fn hook(
        plugin: &str,
        hook: &str,
        stage: &str,
        kind: &str,
        data: Json,
        target: &str,
    ) -> engine::CallError {
        let reason = data.as_str().unwrap_or(kind);
        let message = format!("Hook {plugin}/{hook} ({target} {stage}): {reason}");
        let details = serde_json::json!({ "message":message, "plugin":plugin, "hook":hook, "stage":stage, "kind":kind, "data":data });
        engine::CallError {
            message,
            details: Some(details),
            limit: None,
        }
    }

    pub(crate) fn map_text(self, mut map: impl FnMut(String) -> String) -> Self {
        match self {
            Self::Message(message) => Self::Message(map(message)),
            Self::Structured(mut error) => {
                error.message = map(error.message);
                if let Json::String(data) = &mut error.details.data {
                    *data = map(std::mem::take(data));
                }
                Self::Structured(error)
            }
        }
    }
}

impl From<CallError> for engine::CallError {
    fn from(error: CallError) -> Self {
        match error {
            CallError::Message(message) => message.into(),
            CallError::Structured(error) => Self {
                message: error.message.clone(),
                details: Some(serde_json::json!(error)),
                limit: None,
            },
        }
    }
}

impl From<engine::CallError> for CallError {
    fn from(error: engine::CallError) -> Self {
        error
            .details
            .and_then(|details| serde_json::from_value(details).ok())
            .map_or_else(|| Self::Message(error.message), Self::Structured)
    }
}

impl From<String> for CallError {
    fn from(error: String) -> Self {
        Self::Message(error)
    }
}

impl From<&str> for CallError {
    fn from(error: &str) -> Self {
        error.to_owned().into()
    }
}

impl std::ops::Deref for CallError {
    type Target = str;
    fn deref(&self) -> &str {
        match self {
            Self::Message(message) => message,
            Self::Structured(error) => &error.message,
        }
    }
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionTarget {
    #[default]
    Server,
    Caller,
}

/// IDs fit JavaScript's exact integer range. They share one session-local space;
/// clients must not reuse them while a call or subscription is outstanding.
// ts-rs 12 cannot parse serde's enum deny_unknown_fields; describe the wire shape explicitly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "protocol-codegen", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "protocol-codegen",
    ts(tag = "type", rename_all = "lowercase")
)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Request {
    Query {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        name: String,
        args: Json,
    },
    Mutation {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        name: String,
        args: Json,
    },
    Action {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        name: String,
        args: Json,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(
            feature = "protocol-codegen",
            ts(optional, type = "\"server\" | \"caller\"")
        )]
        on: Option<ActionTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "protocol-codegen", ts(optional, type = "boolean"))]
        window: Option<bool>,
    },
    LocalCall {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        name: String,
        args: Json,
        #[cfg_attr(
            feature = "protocol-codegen",
            ts(type = "\"query\" | \"mutation\" | \"action\"")
        )]
        kind: crate::service::FunctionKind,
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        depth: usize,
        thread: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(
            feature = "protocol-codegen",
            ts(optional, type = "\"server\" | \"caller\"")
        )]
        on: Option<ActionTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "protocol-codegen", ts(optional, type = "boolean"))]
        window: Option<bool>,
    },
    CancelAction {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
    },
    Subscribe {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        name: String,
        args: Json,
    },
    Plugins {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
    },
    PluginsPage {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        revision: String,
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        offset: u64,
    },
    PluginAsset {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        plugin: String,
        name: String,
        revision: String,
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        offset: u64,
    },
    Unsubscribe {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
    },
}

impl Request {
    pub fn id(&self) -> u64 {
        match self {
            Self::Query { id, .. }
            | Self::Mutation { id, .. }
            | Self::Action { id, .. }
            | Self::LocalCall { id, .. }
            | Self::CancelAction { id }
            | Self::Subscribe { id, .. }
            | Self::Unsubscribe { id }
            | Self::Plugins { id }
            | Self::PluginsPage { id, .. }
            | Self::PluginAsset { id, .. } => *id,
        }
    }
}

/// Responses and subscription updates MUST remain on one ordered stream. Serde's
/// Result representation makes success (including null) distinct from an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
// With serde compatibility disabled, keep the generator's wire shape explicit.
#[cfg_attr(feature = "protocol-codegen", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "protocol-codegen",
    ts(tag = "type", rename_all = "lowercase")
)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    PluginChanged {
        plugins: Vec<String>,
        catalog: Json,
    },
    Response {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        result: Result<Json, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "protocol-codegen", ts(optional))]
        error: Option<CallErrorDetails>,
    },
    Subscription {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        result: Result<Json, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "protocol-codegen", ts(optional))]
        error: Option<CallErrorDetails>,
    },
    Unsubscribed {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
    },
}

impl Event {
    pub(crate) fn response(id: u64, result: Result<Json, CallError>) -> Self {
        let (result, error) = Self::outcome(result);
        Self::Response { id, result, error }
    }

    pub(crate) fn subscription(id: u64, result: Result<Json, CallError>) -> Self {
        let (result, error) = Self::outcome(result);
        Self::Subscription { id, result, error }
    }

    fn outcome(
        result: Result<Json, CallError>,
    ) -> (Result<Json, String>, Option<CallErrorDetails>) {
        match result {
            Ok(value) => (Ok(value), None),
            Err(CallError::Message(message)) => (Err(message), None),
            Err(CallError::Structured(error)) => (Err(error.message), Some(error.details)),
        }
    }
}
