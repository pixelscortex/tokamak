//! Failed reads and failed or cancelled mutations poison the transaction.
//! Polled commit/rollback retain database ownership until storage finishes;
//! only successful commits publish changes. The Tokio runtime must stay alive.

use super::{
    ChangeEvent, DatabaseState, Document, Error, Id, Query, RecordChange, Result, Table,
    changes::encoded_size,
};
use std::sync::atomic::Ordering;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard};

use std::{collections::BTreeSet, sync::Arc};
use surrealdb_datastore::Transaction as StorageTransaction;

mod indexes;
mod records;

// Hold the catalog stable from a writer's first mutation through its outcome.
// Read guards coexist; only defining a new index needs exclusive access.
enum CatalogGuard {
    Read { _guard: OwnedRwLockReadGuard<()> },
    Write { _guard: OwnedRwLockWriteGuard<()> },
}

// Arm before any mutation work (including catalog creation and index updates).
// Only a successful return disarms this guard. Errors, panics and dropped
// futures all poison the retained transaction, so partial writes cannot commit.
// Keeping the exclusive borrow here also covers nested reads during a mutation.
struct Mutation<'a> {
    tx: &'a mut Transaction,
    complete: bool,
}

impl<'a> Mutation<'a> {
    fn new(tx: &'a mut Transaction) -> Self {
        Self {
            tx,
            complete: false,
        }
    }

    fn finish<T>(mut self, result: Result<T>) -> Result<T> {
        self.complete = result.is_ok();
        result
    }
}

impl Drop for Mutation<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.tx.failed = true;
        }
    }
}

#[must_use = "commit or roll back the transaction before closing its database"]
pub struct Transaction {
    pub(super) inner: Arc<StorageTransaction>,
    // Keep the database alive and block close until this invocation finishes.
    // Unlike a borrowed sender, this fits a 'static runtime callback safely.
    pub(super) state: Arc<DatabaseState>,
    written: BTreeSet<Table>,
    changes: Option<Vec<RecordChange>>,
    change_bytes: usize,
    read_only: bool,
    failed: bool,
    epochs: (u64, u64),
    catalog_guard: Option<CatalogGuard>,
    catalog_changed: bool,
}

#[cfg(test)]
mod keyed_tests {
    use super::*;
    use crate::data::{Database, Object, Storage};

    #[tokio::test]
    async fn kernel_keyed_create_is_not_an_upsert_and_duplicates_poison_the_transaction() {
        let mut database = Database::open(Storage::Memory).await.unwrap();
        let id = Id::new(Table::new("kernel_metadata").unwrap(), "stable").unwrap();
        let mut tx = database.begin().await.unwrap();
        assert_eq!(tx.insert_keyed(&id, Object::new()).await.unwrap(), id);
        tx.commit().await.unwrap();
        let mut tx = database.begin().await.unwrap();
        assert!(tx.insert_keyed(&id, Object::new()).await.is_err());
        assert!(tx.commit().await.is_err());
        let mut tx = database.read_only().await.unwrap();
        assert!(tx.get(&id).await.unwrap().is_some());
        tx.commit().await.unwrap();
        database.close().await.unwrap();
    }
}

impl Transaction {
    pub(super) fn new(
        inner: StorageTransaction,
        state: Arc<DatabaseState>,
        read_only: bool,
        epochs: (u64, u64),
    ) -> Self {
        Self {
            inner: Arc::new(inner),
            state,
            written: BTreeSet::new(),
            changes: Some(Vec::new()),
            change_bytes: 0,
            read_only,
            failed: false,
            epochs,
            catalog_guard: None,
            catalog_changed: false,
        }
    }

    fn catalog(&mut self, define: bool) -> Result<()> {
        let core = &self.state.storage;

        let conflict = || {
            Error::Database(anyhow::Error::new(
                surrealdb_kvs::err::Error::TransactionConflict(
                    "catalog changed or is in use; retry with a fresh snapshot".into(),
                ),
            ))
        };

        if define && !matches!(self.catalog_guard, Some(CatalogGuard::Write { .. })) {
            // Upgrade by releasing our read guard. Never wait on another
            // call-owned transaction: its owner may be awaiting this operation.
            // Epoch validation below makes a non-atomic upgrade safe.
            self.catalog_guard = None;
            self.catalog_guard = Some(CatalogGuard::Write {
                _guard: core
                    .catalog_gate
                    .clone()
                    .try_write_owned()
                    .map_err(|_| conflict())?,
            });
        } else if self.catalog_guard.is_none() {
            self.catalog_guard = Some(CatalogGuard::Read {
                _guard: core
                    .catalog_gate
                    .clone()
                    .try_read_owned()
                    .map_err(|_| conflict())?,
            });
        }

        let (catalog, writes) = core.epochs();

        if catalog != self.epochs.0 || (define && writes != self.epochs.1) {
            return Err(conflict());
        }

        Ok(())
    }

    fn record(&mut self, before: Option<&Document>, after: Option<&Document>) {
        let Some(changes) = &mut self.changes else {
            return;
        };

        if changes.len() >= 64 {
            self.changes = None;
            return;
        }

        let before = before.cloned().map(Document::into_json);

        let after = after.cloned().map(Document::into_json);

        let Some(bytes) = encoded_size(
            &(&before, &after),
            32768usize.saturating_sub(self.change_bytes),
        ) else {
            self.changes = None;
            return;
        };

        let id = after
            .as_ref()
            .or(before.as_ref())
            .and_then(|v| v["_id"].as_str())
            .expect("change has a before or after image")
            .parse()
            .expect("native record id");
        changes.push(RecordChange { id, before, after });
        self.change_bytes += bytes;
    }

    pub(crate) fn ready(&self, write: bool) -> Result<()> {
        if self.failed {
            return Err(Error::FailedTransaction);
        }

        if write && self.read_only {
            return Err(Error::ReadOnly);
        }

        Ok(())
    }

    pub(crate) fn finish<T>(&mut self, result: Result<T>) -> Result<T> {
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    pub fn query(&mut self, table: &Table) -> Query<'_> {
        Query::new(self, table.clone())
    }

    /// Polled finalization survives caller cancellation. Only the invocation
    /// owner can replay JS safely; commit never retries automatically.
    pub async fn commit(self) -> Result<()> {
        tokio::spawn(self.commit_owned())
            .await
            .map_err(|error| Error::Database(error.into()))?
    }

    async fn commit_owned(self) -> Result<()> {
        if self.failed {
            self.inner.cancel().await?;

            return Err(Error::FailedTransaction);
        }

        if self.read_only {
            // Read transactions have nothing to flush; the backend rejects a
            // read-only commit, while the application API permits it.
            self.inner.cancel().await?;
        } else {
            self.inner.commit().await?;
        }
        // Publish epochs after storage success and before releasing the catalog
        // gate, without an await, so snapshots cannot miss committed changes.
        let core = &self.state.storage;

        if self.catalog_changed {
            core.catalog_epoch.fetch_add(1, Ordering::Release);
        }

        if !self.written.is_empty() {
            core.write_epoch.fetch_add(1, Ordering::Release);
            // One owner sends once after success, including cancelled callers.
            // No receivers is normal before live subscriptions are installed.
            let _ = self.state.changes.send(ChangeEvent {
                tables: self.written.into_iter().collect(),
                records: self.changes,
            });
        }

        Ok(())
    }

    /// Consume the handle and discard its writes without publishing changes.
    /// Once polled, cleanup retains the database and catalog gate until storage
    /// cancellation resolves, even if the caller drops this future.
    pub async fn rollback(self) -> Result<()> {
        tokio::spawn(async move {
            let result = self.inner.cancel().await.map_err(Error::from);
            // Retain ALL of self, not just inner, through the cleanup await.
            drop(self);
            result
        })
        .await
        .map_err(|error| Error::Database(error.into()))?
    }
}
