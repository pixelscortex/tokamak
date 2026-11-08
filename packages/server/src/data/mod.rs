//! Embedded application storage: one fixed root namespace/database, no schema.
//! All data operations require an explicit transaction so separate JS
//! host calls can commit atomically. Only this API publishes write footprints;
//! there is deliberately no raw client, SQL entry point, or storage wiretap.

mod changes;
mod query;
mod space;
mod transaction;
mod types;

// Internal ownership checks can inspect the supplied datastore without exposing
// an untracked raw-write capability in the public or feature-facing API.
#[cfg(test)]
#[path = "../../tests/internal/datastore_owner.rs"]
mod ownership_tests;

pub use changes::{ReadSet, RecordChange, json_equal};
pub use query::Query;
pub use space::{DataSpace, json_object};
pub use surrealdb::types::{Object, SurrealValue, Value};
pub use transaction::Transaction;
pub use types::{Document, Error, Id, Order, Result, Table};

use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};
use surrealdb::{Surreal, engine::local::Db};
use surrealdb_core::kvs::Datastore;
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
    /// None means conservatively invalidate the whole listed tables. Retained
    /// record images are bounded; this remains an ephemeral notification.
    pub records: Option<Vec<RecordChange>>,
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
    // Keep the explicit owner alongside the ONLY SDK attachment. Features never
    // receive this raw handle: bypass writes would evade tracked invalidation.
    datastore: Arc<Datastore>,
    changes: broadcast::Sender<ChangeEvent>,
}

fn startup_error(
    error: impl std::fmt::Display,
    cleanup: std::result::Result<(), impl std::fmt::Display>,
) -> String {
    match cleanup {
        Ok(()) => error.to_string(),
        Err(cleanup) => format!("{error}; startup cleanup failed: {cleanup}"),
    }
}

impl Database {
    /// Narrow crate-internal diagnostic access, not a feature capability or an
    /// independently managed SDK attachment. Do not retain across close.
    #[allow(dead_code)]
    pub(crate) fn datastore(&self) -> Result<&Arc<Datastore>> {
        Ok(&self.state()?.datastore)
    }

    /// Box the embedded engine's deep startup future at this ownership boundary.
    /// Callers keep the same `.await` API without inheriting its enormous layout
    /// or needing their own recursion-limit/stack configuration.
    pub fn open(storage: Storage) -> Pin<Box<dyn Future<Output = Result<Self>> + Send>> {
        Box::pin(Self::open_owned(storage))
    }

    async fn open_owned(storage: Storage) -> Result<Self> {
        let path = match storage {
            Storage::Memory => "memory".to_owned(),
            Storage::Disk(path) => format!(
                "surrealkv://{}",
                path.to_str()
                    .ok_or(Error::Invalid("database path must be UTF-8"))?
            ),
        };
        // Version/bootstrap writes must precede background maintenance. The
        // supplied-datastore SDK bridge deliberately does none of this setup.
        let datastore = Box::pin(
            Datastore::builder()
                .without_maintenance_tasks()
                .build_with_path(&path),
        )
        .await
        .map_err(|e| Error::Startup(e.to_string()))?;
        let startup = async {
            Box::pin(datastore.check_version()).await?;
            Box::pin(datastore.bootstrap()).await?;
            Box::pin(datastore.start_maintenance_tasks_checked()).await
        }
        .await;
        if let Err(error) = startup {
            let cleanup = datastore.shutdown().await;
            return Err(Error::Startup(startup_error(error, cleanup)));
        }
        let client = match Surreal::<Db>::unstable_from_datastore(datastore.clone(), None).await {
            Ok(client) => client,
            Err(error) => {
                let cleanup = datastore.shutdown().await;
                return Err(Error::Startup(startup_error(error, cleanup)));
            }
        };
        if let Err(error) = client.use_ns("tokamak").use_db("tokamak").await {
            // After attachment the SDK owns shutdown, including its routing task.
            let cleanup = client.shutdown().await;
            return Err(Error::Startup(startup_error(error, cleanup)));
        }
        let (changes, _) = broadcast::channel(256);
        Ok(Self {
            state: Lifecycle::Open(Arc::new(DatabaseState {
                client,
                datastore,
                changes,
            })),
        })
    }

    pub(crate) fn has_transactions(&self) -> bool {
        matches!(&self.state, Lifecycle::Open(state) if Arc::strong_count(state) != 1)
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
                    let result = state.client.shutdown().await;
                    // Shutdown alone is not a disk-lock barrier while retained
                    // Arc references still own the storage engine.
                    drop(state);
                    result
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
