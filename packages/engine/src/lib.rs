//! Shared JavaScript engine and host operations for server and render.
//!
//! Backend calls use a bounded pool and fresh worlds; UI code can instead own
//! a `QuickJsContext` on its event-loop thread. Actions install the documented web API subset.

mod action;
mod bridge;
mod determinism;
mod engine;
mod pool;
mod source_map;
mod types;
pub mod web;

pub use action::ActionEngine;
pub use bridge::{Invocation, ModuleCall, OpRegistry, install_ops};
pub use determinism::Determinism;
pub use engine::{Engine, QuickJsContext, QuickJsEngine};
pub use pool::{PendingCall, Pool, PoolConfig};
pub use types::{Bundle, Error, Limits};

pub use rquickjs;
pub use serde_json::Value as Json;
