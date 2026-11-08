//! A call-owned SDK transaction, retained across separate operations/awaits.
//! Failed operations poison the whole call so catching a host error cannot save
//! earlier writes. The write set is local until commit succeeds, then published
//! synchronously before returning. Rollback and failed commits publish nothing.

use super::{
    ChangeEvent, DatabaseState, Document, Error, Id, Query, RecordChange, Result, Table,
    changes::encoded_size, types::check_fields,
};
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use surrealdb::{
    engine::local::Db,
    types::{NotFoundError, Object, Value},
};

#[must_use = "commit or roll back the transaction before closing its database"]
pub struct Transaction {
    inner: surrealdb::method::Transaction<Db>,
    // Keep the database alive and block close until this invocation finishes.
    // Unlike a borrowed sender, this fits a 'static runtime callback safely.
    state: Arc<DatabaseState>,
    written: BTreeSet<Table>,
    changes: Option<Vec<RecordChange>>,
    change_bytes: usize,
    read_only: bool,
    failed: bool,
}

impl Transaction {
    pub(super) fn new(
        inner: surrealdb::method::Transaction<Db>,
        state: Arc<DatabaseState>,
        read_only: bool,
    ) -> Self {
        Self {
            inner,
            state,
            written: BTreeSet::new(),
            changes: Some(Vec::new()),
            change_bytes: 0,
            read_only,
            failed: false,
        }
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

    /// Only our fixed statements reach here. Even names/IDs/limits are bindings.
    /// An absent table is an empty read in a schemaless application, not DDL.
    pub(crate) async fn rows(
        &mut self,
        sql: String,
        bindings: Object,
        write: bool,
    ) -> Result<Vec<Document>> {
        let result = async {
            self.ready(write)?;
            let response = self.inner.query(sql).bind(bindings).await?;
            let mut response = match response.check() {
                Ok(response) => response,
                Err(error)
                    if !write
                        && matches!(
                            error.not_found_details(),
                            Some(NotFoundError::Table { .. })
                        ) =>
                {
                    return Ok(Vec::new());
                }
                Err(error) => return Err(error.into()),
            };
            let rows: Vec<Value> = response.take(0)?;
            rows.into_iter().map(Document::decode).collect()
        }
        .await;
        self.finish(result)
    }

    pub async fn get(&mut self, id: &Id) -> Result<Option<Document>> {
        let mut bindings = Object::new();
        bindings.insert("id", id.record());
        Ok(self
            .rows("SELECT * FROM $id".into(), bindings, false)
            .await?
            .pop())
    }

    pub async fn insert(&mut self, table: &Table, value: Object) -> Result<Id> {
        let result = async {
            self.ready(true)?;
            check_fields(&value)?;
            // Epoch milliseconds are immutable metadata, not a user-supplied sort key.
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::Invalid("clock is before the Unix epoch"))?
                .as_millis();
            let millis =
                i64::try_from(millis).map_err(|_| Error::Invalid("clock is out of range"))?;
            let mut stored = Object::new();
            stored.insert("_creationTime", millis);
            stored.insert("data", value);
            let mut bindings = Object::new();
            bindings.insert("table", table.as_str());
            bindings.insert("value", stored);
            let row = self
                .rows(
                    "CREATE type::table($table) CONTENT $value RETURN AFTER".into(),
                    bindings,
                    true,
                )
                .await?
                .pop()
                .ok_or(Error::Invalid("insert returned no document"))?;
            self.written.insert(table.clone());
            self.record(None, Some(&row));
            Ok(row.id)
        }
        .await;
        self.finish(result)
    }

    pub async fn patch(&mut self, id: &Id, value: Object) -> Result<()> {
        self.update(id, value, false).await
    }

    pub async fn replace(&mut self, id: &Id, value: Object) -> Result<()> {
        self.update(id, value, true).await
    }

    async fn update(&mut self, id: &Id, value: Object, replace: bool) -> Result<()> {
        let result = async {
            self.ready(true)?;
            check_fields(&value)?;
            let old = self.get(id).await?.ok_or(Error::MissingRecord)?;
            let mut fields = if replace {
                Object::new()
            } else {
                old.fields.clone()
            };
            for (key, value) in value {
                fields.insert(key, value);
            }
            // Do not claim a table write when the document would be unchanged.
            if fields == old.fields {
                return Ok(());
            }
            let mut stored = Object::new();
            stored.insert("_creationTime", old.creation_time);
            stored.insert("data", fields);
            let mut bindings = Object::new();
            bindings.insert("id", id.record());
            bindings.insert("value", stored);
            let mut rows = self
                .rows(
                    "UPDATE $id CONTENT $value RETURN AFTER".into(),
                    bindings,
                    true,
                )
                .await?;
            let persisted = rows.pop().ok_or(Error::MissingRecord)?;
            // The engine can normalize distinct inputs to the same document
            // (for example, omitting NONE-valued fields). Its returned data,
            // not our pre-storage payload, decides whether observers changed.
            if persisted.fields != old.fields {
                self.written.insert(id.table().clone());
                self.record(Some(&old), Some(&persisted));
            }
            Ok(())
        }
        .await;
        self.finish(result)
    }

    /// Deleting an absent record is a no-op and must not report its table.
    pub async fn delete(&mut self, id: &Id) -> Result<()> {
        let result = async {
            self.ready(true)?;
            let Some(old) = self.get(id).await? else {
                return Ok(());
            };
            let mut bindings = Object::new();
            bindings.insert("id", id.record());
            let rows = self
                .rows("DELETE $id RETURN BEFORE".into(), bindings, true)
                .await?;
            if !rows.is_empty() {
                self.written.insert(id.table().clone());
                self.record(Some(&old), None);
            }
            Ok(())
        }
        .await;
        self.finish(result)
    }

    pub fn query(&mut self, table: &Table) -> Query<'_> {
        Query::new(self, table.clone())
    }

    /// Consume the handle: neither a second commit nor late JS writes are possible.
    /// No automatic retry: only the invocation owner can safely replay JS logic.
    pub async fn commit(self) -> Result<()> {
        if self.failed {
            self.inner.cancel().await?;
            return Err(Error::FailedTransaction);
        }
        self.inner.commit().await?;
        if !self.written.is_empty() {
            // No receivers is normal before live subscriptions are installed.
            let _ = self.state.changes.send(ChangeEvent {
                tables: self.written.into_iter().collect(),
                records: self.changes,
            });
        }
        Ok(())
    }

    /// Await rollback explicitly; SDK drop rollback is asynchronous and requires
    /// a live Tokio runtime, so it is only a cancellation safety net.
    pub async fn rollback(self) -> Result<()> {
        self.inner.cancel().await?;
        Ok(())
    }
}
