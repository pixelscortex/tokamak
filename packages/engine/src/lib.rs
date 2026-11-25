//! Server JavaScript engine and host operations.
//! Backend calls use a bounded pool and fresh worlds.
//! Actions install the documented web API subset.

mod action;
mod bridge;
mod determinism;
mod engine;
mod password;
mod pool;
mod source_map;
mod types;
pub mod web;

pub use action::ActionEngine;
pub use bridge::{
    CallError, CallFuture, CallTransforms, Invocation, ModuleCall, OpRegistry, StageExecutor,
    install_ops,
};
pub use determinism::Determinism;
pub use engine::{Engine, QuickJsContext, QuickJsEngine};
pub use password::register_password_crypto;
pub use pool::{PendingCall, Pool, PoolConfig};
pub use types::{Bundle, Error, Limits};

pub use rquickjs;
pub use serde_json::Value as Json;

/// Maximum serialized UTF-8 request/event payload shared by native and WebSocket
/// hosts. Native routing envelopes are separate, bounded mailbox overhead.
pub const MAX_WIRE_MESSAGE_BYTES: usize = 1024 * 1024;

#[cfg(test)]
mod tests {
    #[test]
    fn plugin_json_number_round_trips_exactly() {
        let text = "0.018920700000000002";
        let value: serde_json::Value = serde_json::from_str(text).unwrap();

        assert_eq!(serde_json::to_string(&value).unwrap(), text);
    }
}
