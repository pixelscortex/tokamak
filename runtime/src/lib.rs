//! Shared JavaScript setup and host operations for server and render.
//!
//! Backend calls use a bounded pool and fresh worlds; UI code can instead own
//! a `QuickJsContext` on its event-loop thread. Neither API installs web APIs.

mod bridge;
mod engine;
mod pool;
mod source_map;
mod types;

pub use bridge::{Invocation, OpRegistry, install_ops};
pub use engine::{Engine, QuickJsContext, QuickJsEngine};
pub use pool::{PendingCall, Pool, PoolConfig};
pub use types::{Bundle, Error, Limits};
// Render needs the same engine types, not a second dependency/setup path.
pub use rquickjs;
pub use serde_json::Value as Json;
