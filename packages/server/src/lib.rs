//! Combined backend library: embedded storage, feature workers, and one bounded
//! Tower service. Desktop uses WebSocket; in-process sessions remain a library API.
//! Application functions remain SDK bundles using call-owned tracked transactions,
//! without SQL or an auto-committing feature capability.

// Embedded datastore startup contains deeply nested engine futures.
#![recursion_limit = "256"]

mod backend;
pub mod data;
mod host;
pub mod plugins;
pub mod protocol;
mod service;
pub mod websocket;

pub use backend::{Backend, BackendConfig};
pub use service::{Error, Event, Server, Session, SessionSender};
