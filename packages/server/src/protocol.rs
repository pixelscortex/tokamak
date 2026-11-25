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
    },
    Subscription {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        result: Result<Json, String>,
    },
    Unsubscribed {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
    },
}
