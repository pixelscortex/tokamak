//! Library-first composition of storage, JS workers and the common service.
//! Both standalone server and Runner expose the WebSocket transport.

use crate::{
    Error, Server, Session,
    data::{DataSpace, Database, Storage},
    plugins::StartupPolicy,
};
use engine::{Bundle, Pool, PoolConfig};
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
    pub async fn start_plugins(
        storage: Storage,
        javascript: PoolConfig,
        root: &std::path::Path,
    ) -> Result<Self, Error> {
        Self::start_plugin_installation(storage, javascript, root, StartupPolicy::Strict).await
    }

    /// Keep shared-server recovery and existing credentials available when
    /// installed plugin modules fail to initialize.
    pub async fn start_shared_plugins(
        storage: Storage,
        javascript: PoolConfig,
        root: &std::path::Path,
    ) -> Result<Self, Error> {
        Self::start_plugin_installation(storage, javascript, root, StartupPolicy::Recover).await
    }

    async fn start_plugin_installation(
        storage: Storage,
        javascript: PoolConfig,
        root: &std::path::Path,
        policy: StartupPolicy,
    ) -> Result<Self, Error> {
        let pool = Arc::new(Pool::new(javascript).map_err(|e| Error::Invalid(e.to_string()))?);
        let database = Database::open(storage)
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let server = Server::load_plugin_catalog(database, pool, root, policy).await?;
        Ok(Self {
            server: Arc::new(server),
        })
    }

    pub async fn start(config: BackendConfig) -> Result<Self, Error> {
        Self::start_in_space(config, DataSpace::default()).await
    }

    pub async fn start_in_space(config: BackendConfig, space: DataSpace) -> Result<Self, Error> {
        // Validate/spawn workers before opening storage, so pool startup errors
        // cannot leave a live datastore behind. Server::load cleans failed bundles.
        let pool =
            Arc::new(Pool::new(config.javascript).map_err(|e| Error::Invalid(e.to_string()))?);
        let database = Database::open(config.storage)
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let server = Server::load_in_space(database, pool, config.bundle, space).await?;
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
