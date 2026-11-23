//! Combined backend library: embedded storage, feature workers, and one bounded
//! Tower service. Desktop uses WebSocket; in-process sessions remain a library API.
//! Application functions remain SDK bundles using call-owned tracked transactions,
//! without SQL or an auto-committing feature capability.

// Embedded datastore startup contains deeply nested engine futures.
#![recursion_limit = "256"]

mod actions;
mod backend;
pub mod data;
mod environment;
mod host;
pub mod identity;
pub mod local_endpoint;
pub mod plugins;
pub mod protocol;
mod schema;
mod service;
mod web;
pub mod websocket;

pub use backend::{Backend, BackendConfig};
pub use service::{Error, Event, Server, Session, SessionSender};

/// Selects server action execution. Only the Runner build has a Bun fallback.
pub fn action_runtime() -> Result<&'static str, String> {
    #[cfg(feature = "local-runtime")]
    {
        tokamak_worker::LocalRuntime::selected().map(|runtime| runtime.name())
    }
    #[cfg(not(feature = "local-runtime"))]
    {
        Ok("quickjs")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn plugin_json_number_round_trips_exactly() {
        let text = "0.018920700000000002";
        let value: serde_json::Value = serde_json::from_str(text).unwrap();

        assert_eq!(serde_json::to_string(&value).unwrap(), text);
    }
}
