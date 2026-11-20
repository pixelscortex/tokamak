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
mod plugin_log;
pub mod plugins;
pub mod protocol;
mod schema;
mod service;
mod web;
pub mod websocket;

pub use backend::{Backend, BackendConfig};
pub use service::{Error, Event, Server, Session, SessionSender};
