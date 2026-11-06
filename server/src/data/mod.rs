//! Embedded application storage: one fixed root namespace/database, no schema.
//! All data operations require an explicit transaction so separate JS
//! host calls can commit atomically. Only this API publishes write footprints;
//! there is deliberately no raw client, SQL entry point, or storage wiretap.

mod query;
mod transaction;
mod types;

pub use query::Query;
pub use surrealdb::types::{Object, SurrealValue, Value};
pub use transaction::Transaction;
pub use types::{Document, Error, Id, Order, Result, Table};

use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};
use surrealdb::{
    Surreal,
    engine::local::{Db, Mem, SurrealKv},
};
use tokio::sync::{Mutex, broadcast};

/// A filesystem path is not an endpoint string: it cannot select a remote engine.
#[derive(Debug, Clone)]
pub enum Storage {
    Memory,
    Disk(PathBuf),
}

/// One successful transaction's deduplicated, sorted write footprint.
/// Receivers that lag must invalidate all subscriptions; this is not a durable log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeEvent {
    pub tables: Vec<Table>,
}

/// The database owner. Transactions retain shared state rather than borrowing
/// this handle, so a JS invocation can capture them in Send + Sync + 'static ops.
/// Only this handle can shut down; close rejects active transactions recoverably.
pub struct Database {
    state: Lifecycle,
}

// Shutdown is an owned future, not a detached task. Retaining it across cancelled
// close calls makes the next close await the SAME disk-lock release barrier.
// Mutex supplies Sync for a Send future; close has &mut self and uses get_mut,
// so there is no runtime lock or competing shutdown poller.
enum Lifecycle {
    Open(Arc<DatabaseState>),
    Closing(Mutex<Pin<Box<dyn Future<Output = surrealdb::Result<()>> + Send>>>),
    Closed(surrealdb::Result<()>),
}

// Shared only with transactions, not independently cloneable database owners.
// The strong count therefore tells close whether an invocation still owns a tx.
pub(super) struct DatabaseState {
    client: Surreal<Db>,
    changes: broadcast::Sender<ChangeEvent>,
}

impl Database {
    pub async fn open(storage: Storage) -> Result<Self> {
        let client = match storage {
            Storage::Memory => Surreal::new::<Mem>(()).await?,
            Storage::Disk(path) => {
                let path = path
                    .to_str()
                    .ok_or(Error::Invalid("database path must be UTF-8"))?;
                Surreal::new::<SurrealKv>(path).await?
            }
        };
        client.use_ns("tokamak").use_db("tokamak").await?;
        let (changes, _) = broadcast::channel(256);
        Ok(Self {
            state: Lifecycle::Open(Arc::new(DatabaseState { client, changes })),
        })
    }

    /// After close this returns an already-closed receiver, preserving the
    /// subscription interface without keeping the database/event sender alive.
    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        match &self.state {
            Lifecycle::Open(state) => state.changes.subscribe(),
            Lifecycle::Closing(_) | Lifecycle::Closed(_) => {
                let (_, receiver) = broadcast::channel(1);
                receiver
            }
        }
    }

    fn state(&self) -> Result<&Arc<DatabaseState>> {
        match &self.state {
            Lifecycle::Open(state) => Ok(state),
            Lifecycle::Closing(_) | Lifecycle::Closed(_) => Err(Error::Closed),
        }
    }

    /// Snapshot isolation, not serializability: write skew is possible. The
    /// feature service replays the WHOLE invocation on a typed conflict.
    pub async fn begin(&self) -> Result<Transaction> {
        let state = self.state()?;
        let tx = state.client.clone().begin().await?;
        Ok(Transaction::new(tx, Arc::clone(state), false))
    }

    /// Both the wrapper and the engine reject writes in a read-only call.
    pub async fn read_only(&self) -> Result<Transaction> {
        let state = self.state()?;
        let tx = state.client.clone().begin().read_only().await?;
        Ok(Transaction::new(tx, Arc::clone(state), true))
    }

    /// Busy leaves the database open. Once shutdown starts, data operations
    /// fail Closed; cancellation retains shutdown progress for the next close.
    /// Success means the disk lock is released. Repeated calls return the same
    /// completed result, including a shutdown failure rather than false success.
    pub async fn close(&mut self) -> Result<()> {
        if let Lifecycle::Open(state) = &self.state {
            if Arc::strong_count(state) != 1 {
                return Err(Error::Busy);
            }
            // No await occurs while transferring the sole owner to shutdown.
            // &mut self excludes begin, so a new tx cannot race this transition.
            if let Lifecycle::Open(state) =
                std::mem::replace(&mut self.state, Lifecycle::Closed(Ok(())))
            {
                self.state = Lifecycle::Closing(Mutex::new(Box::pin(async move {
                    state.client.shutdown().await
                })));
            }
        }
        let result = match &mut self.state {
            Lifecycle::Closing(shutdown) => shutdown.get_mut().as_mut().await,
            Lifecycle::Closed(result) => return result.clone().map_err(Error::from),
            Lifecycle::Open(_) => unreachable!("open state was moved to shutdown above"),
        };
        // Drop the completed future and its SDK owner before reporting success;
        // otherwise a caller could still encounter a held SurrealKV lock.
        self.state = Lifecycle::Closed(result.clone());
        result.map_err(Error::from)
    }
}
