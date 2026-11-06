//! Native feature hosting without transport or application logic. The service
//! runs SDK bundles against call-owned storage transactions across awaits,
//! without exposing SQL or an auto-committing client escape hatch.

pub mod data;
mod host;
mod service;

pub use service::{Error, Event, Server, Session, SessionSender};
