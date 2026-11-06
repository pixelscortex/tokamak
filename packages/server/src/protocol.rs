//! The single wire contract for native and WebSocket clients. `export-protocol`
//! generates SDK types from these serde types; neither transport invents events.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// IDs fit JavaScript's exact integer range. They share one session-local space;
/// clients must not reuse them while a call or subscription is outstanding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "protocol-codegen", derive(ts_rs::TS))]
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
    Subscribe {
        #[cfg_attr(feature = "protocol-codegen", ts(type = "number"))]
        id: u64,
        name: String,
        args: Json,
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
            | Self::Subscribe { id, .. }
            | Self::Unsubscribe { id } => *id,
        }
    }
}

/// Responses and subscription updates MUST remain on one ordered stream. Serde's
/// Result representation makes success (including null) distinct from an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "protocol-codegen", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
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
