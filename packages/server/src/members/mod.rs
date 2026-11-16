//! Host-owned identity. Plugins receive callers, never member storage or tokens.
pub mod guest_listener;
mod invite;
pub(crate) mod limits;
mod store;

pub use invite::InviteOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    pub member_id: String,
    pub name: String,
    pub role: String,
}

impl Caller {
    pub(crate) fn owner() -> Self {
        Self {
            member_id: "owner".into(),
            name: "Owner".into(),
            role: "owner".into(),
        }
    }

    pub(crate) fn is_guest(&self) -> bool {
        self.role == "guest"
    }

    pub(crate) fn register(&self, ops: &mut engine::OpRegistry) {
        let caller = serde_json::to_value(self).expect("caller");
        ops.register_sync("host.caller", move |_| Ok(caller.clone()))
            .expect("unique operation");
        if self.is_guest() {
            for name in [
                "acp.agents",
                "acp.open",
                "acp.prompt",
                "acp.next",
                "acp.close",
                "acp.respond",
                "acp.cancel",
            ] {
                ops.register_sync(name, |_| Err("Not available to guests".into()))
                    .expect("unique operation");
            }
        }
    }
}

pub(crate) enum Operation {
    Invite(InviteOptions),
    List,
    Revoke(String),
    Join { code: String, name: String },
}

pub(crate) async fn execute(
    database: &crate::data::Database,
    operation: Operation,
) -> Result<Json, String> {
    store::execute(database, operation)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn authenticate(
    database: &crate::data::Database,
    token: &str,
) -> Result<Caller, String> {
    store::authenticate(database, token)
        .await
        .map_err(|_| "Invalid member token".into())
}
