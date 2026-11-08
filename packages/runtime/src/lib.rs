//! Application hosting, separate from low-level JavaScript execution.
#[cfg(feature = "client")]
pub mod client;

#[cfg(feature = "server")]
pub mod server {
    pub use ::server::{Backend, BackendConfig, Error, data::Storage};
    pub use engine::{Bundle, Limits, PoolConfig};
}
