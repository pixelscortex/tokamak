//! Shared JavaScript engine and host operations for server and render.
//!
//! Backend calls use a bounded pool and fresh worlds; UI code can instead own
//! a `QuickJsContext` on its event-loop thread. Neither API installs web APIs.

mod bridge;
mod determinism;
mod engine;
mod pool;
mod source_map;
mod types;

pub use bridge::{Invocation, ModuleCall, OpRegistry, install_ops};
pub use determinism::Determinism;
pub use engine::{Engine, QuickJsContext, QuickJsEngine};
pub use pool::{PendingCall, Pool, PoolConfig};
pub use types::{Bundle, Error, Limits};

pub use rquickjs;
pub use serde_json::Value as Json;

/// Maximum serialized UTF-8 request/event payload shared by native and WebSocket
/// hosts. Native routing envelopes are separate, bounded mailbox overhead.
pub const MAX_WIRE_MESSAGE_BYTES: usize = 1024 * 1024;
