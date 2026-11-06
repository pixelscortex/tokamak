//! Library-first composition of storage, JS workers and the common service.
//! Desktop calls connect without binding anything; headless opts into WebSocket.

use crate::{
    Error, Server, Session,
    data::{Database, Storage},
};
use runtime::{Bundle, Pool, PoolConfig};
use std::sync::Arc;

pub struct BackendConfig {
    pub storage: Storage,
    pub bundle: Arc<Bundle>,
    /// Worker/heap/time budgets, not reserved CPU cores or hard process isolation.
    pub javascript: PoolConfig,
}

pub struct Backend {
    server: Arc<Server>,
}

impl Backend {
    pub async fn start(config: BackendConfig) -> Result<Self, Error> {
        // Validate/spawn workers before opening storage, so pool startup errors
        // cannot leave a live datastore behind. Server::load cleans failed bundles.
        let pool =
            Arc::new(Pool::new(config.javascript).map_err(|e| Error::Invalid(e.to_string()))?);
        let database = Database::open(config.storage)
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let server = Server::load(database, pool, config.bundle).await?;
        Ok(Self {
            server: Arc::new(server),
        })
    }

    pub fn server(&self) -> &Arc<Server> {
        &self.server
    }

    /// In-process transport: the receiver owns subscription lifetime. Feed its
    /// ordered Events into the SDK message transport; dropping it retires them.
    pub async fn connect(&self) -> Result<Session, Error> {
        self.server.connect().await
    }

    pub async fn close(&self) -> Result<(), Error> {
        self.server.close().await
    }
}
