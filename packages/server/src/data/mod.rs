//! Embedded application storage: one fixed root namespace/database, no schema.
//! All data operations require an explicit transaction so separate JS
//! host calls can commit atomically. Only this API publishes write footprints;
//! there is deliberately no raw client, SQL entry point, or storage wiretap.

mod changes;
mod query;
mod space;
mod storage;
mod transaction;
mod types;

// Internal ownership checks inspect raw storage without exposing an untracked
// write capability in the public or feature-facing API.
#[cfg(test)]
#[path = "../../tests/internal/datastore_owner.rs"]
mod ownership_tests;

pub use changes::{ReadSet, RecordChange, json_equal};
pub use query::Query;
pub use space::{DataSpace, json_object};
pub use surrealdb_types::{Object, SurrealValue, Value};
pub use transaction::Transaction;
pub use types::{Document, Error, Id, Order, Result, Table};

use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};
use storage::StorageCore;
use surrealdb_kvs::TransactionType;
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
    directory: Option<PathBuf>,
}

// Shutdown is an owned future, not a detached task. Retaining it across cancelled
// close calls makes the next close await the SAME disk-lock release barrier.
// Mutex supplies Sync for a Send future; close has &mut self and uses get_mut,
// so there is no runtime lock or competing shutdown poller.
type Shutdown = Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send>>;

enum Lifecycle {
    Open(Arc<DatabaseState>),
    Closing(Mutex<Shutdown>),
    Closed(std::result::Result<(), String>),
}

// Shared only with transactions, not independently cloneable database owners.
// The strong count therefore tells close whether an invocation still owns a tx.
pub(super) struct DatabaseState {
    storage: StorageCore,
    changes: broadcast::Sender<ChangeEvent>,
}

impl Database {
    /// Open just the storage backend and the fixed application catalog.
    pub fn open(storage: Storage) -> Pin<Box<dyn Future<Output = Result<Self>> + Send>> {
        Box::pin(Self::open_owned(storage))
    }

    async fn open_owned(storage: Storage) -> Result<Self> {
        let directory = match &storage {
            Storage::Memory => None,
            Storage::Disk(path) => Some(
                path.parent()
                    .filter(|path| !path.as_os_str().is_empty())
                    .unwrap_or(std::path::Path::new("."))
                    .to_owned(),
            ),
        };
        let path = match storage {
            Storage::Memory => "mem://".to_owned(),
            Storage::Disk(path) => format!(
                "surrealkv://{}",
                path.to_str()
                    .ok_or(Error::Invalid("database path must be UTF-8"))?
            ),
        };

        let storage = StorageCore::open(&path)
            .await
            .map_err(|e| Error::Startup(e.to_string()))?;

        let (changes, _) = broadcast::channel(256);

        Ok(Self {
            state: Lifecycle::Open(Arc::new(DatabaseState { storage, changes })),
            directory,
        })
    }

    pub(crate) fn directory(&self) -> Option<&std::path::Path> {
        self.directory.as_deref()
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
        self.transaction(false).await
    }

    /// Both the wrapper and the engine reject writes in a read-only call.
    pub async fn read_only(&self) -> Result<Transaction> {
        self.transaction(true).await
    }

    async fn transaction(&self, read_only: bool) -> Result<Transaction> {
        let state = self.state()?;

        let epochs = state.storage.epochs();

        let kind = if read_only {
            TransactionType::Read
        } else {
            TransactionType::Write
        };

        let tx = state
            .storage
            .factory
            .transaction(kind, state.storage.sequences.clone())
            .await?;

        Ok(Transaction::new(tx, Arc::clone(state), read_only, epochs))
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
                    let result = state
                        .storage
                        .factory
                        .shutdown()
                        .await
                        .map_err(|e| e.to_string());
                    // Shutdown alone is not a disk-lock barrier while retained
                    // Arc references still own the storage engine.
                    drop(state);
                    result
                })));
            }
        }

        let result = match &mut self.state {
            Lifecycle::Closing(shutdown) => shutdown.get_mut().as_mut().await,
            Lifecycle::Closed(result) => {
                return result
                    .clone()
                    .map_err(|e| Error::Database(anyhow::anyhow!(e)));
            }
            Lifecycle::Open(_) => unreachable!("open state was moved to shutdown above"),
        };
        // Drop the completed future and its storage owner before reporting success;
        // otherwise a caller could still encounter a held SurrealKV lock.
        self.state = Lifecycle::Closed(result.clone());
        result.map_err(|e| Error::Database(anyhow::anyhow!(e)))
    }
}
