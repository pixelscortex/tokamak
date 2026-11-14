//! A call-owned storage transaction, retained across separate operations/awaits.
//! Failed operations poison the whole call so catching a host error cannot save
//! earlier writes. The write set is local until commit succeeds, then published
//! synchronously before returning. Rollback and failed commits publish nothing.

use super::{
    ChangeEvent, DatabaseState, Document, Error, Id, Query, RecordChange, Result, Table,
    changes::encoded_size, types::check_fields,
};
use super::{
    Object, Value,
    types::{check_field, normalize},
};
use std::borrow::Cow;
use std::sync::atomic::Ordering;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard};

use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use surrealdb_datastore::{
    Transaction as StorageTransaction,
    key::schema::{RecordKey, RecordPrefix},
};
use surrealdb_idx::{
    catalog::{Index, IndexDefinition, Record, providers::*},
    val::{TableName, Value as StoredValue},
};
use surrealdb_kvs::key::KVKeyDecode;

// Hold the catalog stable from a writer's first mutation through its outcome.
// Read guards coexist; only defining a new index needs exclusive access.
enum CatalogGuard {
    Read { _guard: OwnedRwLockReadGuard<()> },
    Write { _guard: OwnedRwLockWriteGuard<()> },
}

// A storage commit can apply before its future is cancelled. Advance on every
// exit from an attempted commit, including cancellation and ambiguous errors,
// while the transaction still holds its catalog guard. This may force a harmless
// retry after a failed commit; it cannot let a stale snapshot miss durable DDL
// or rows. Updating only after await would leave that cancellation window open.
struct CommitEpoch<'a> {
    core: &'a super::storage::StorageCore,
    catalog: bool,
    writes: bool,
}
impl Drop for CommitEpoch<'_> {
    fn drop(&mut self) {
        if self.catalog {
            self.core.catalog_epoch.fetch_add(1, Ordering::Release);
        }
        if self.writes {
            self.core.write_epoch.fetch_add(1, Ordering::Release);
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
    use crate::data::{Database, Storage};

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

    pub async fn get(&mut self, id: &Id) -> Result<Option<Document>> {
        let result = async {
            self.ready(false)?;
            let core = &self.state.storage;
            let rid = id.record();
            let record = self
                .inner
                .get_record(core.ns, core.db, &rid.table, &rid.key, None)
                .await?;
            if record.data == StoredValue::None {
                return Ok(None);
            }
            Ok(Some(Document::decode(record.data.clone())?))
        }
        .await;
        self.finish(result)
    }

    /// Scan keys in storage ID order, then decode through get_record so the
    /// catalog's record envelope and canonical identity remain authoritative.
    pub(super) async fn scan_table(&self, table: &Table) -> Result<Vec<Document>> {
        let core = &self.state.storage;
        let table = TableName::from(table.as_str());
        let range = RecordPrefix {
            ns: core.ns,
            db: core.db,
            tb: Cow::Borrowed(&table),
        }
        .range()?;
        let keys = self.inner.keys_raw(range, u32::MAX, 0, None).await?;
        let mut documents = Vec::with_capacity(keys.len());
        for key in keys {
            let key = RecordKey::decode_key(&key)?;
            let record = self
                .inner
                .get_record(core.ns, core.db, &table, &key.id, None)
                .await?;
            documents.push(Document::decode(record.data.clone())?);
        }
        Ok(documents)
    }

    pub async fn insert(&mut self, table: &Table, value: Object) -> Result<Id> {
        self.create(table, None, value).await
    }

    /// Kernel metadata uses deterministic keys for direct lookup. This is not a
    /// JavaScript capability; keyed insertion rejects duplicates and poisons the
    /// transaction rather than silently replacing existing data.
    pub(crate) async fn insert_keyed(&mut self, id: &Id, value: Object) -> Result<Id> {
        self.create(id.table(), Some(id), value).await
    }

    async fn create(&mut self, table: &Table, id: Option<&Id>, value: Object) -> Result<Id> {
        let result = async {
            self.ready(true)?;
            check_fields(&value)?;
            let Value::Object(fields) = normalize(Value::Object(value), 0)? else {
                unreachable!()
            };
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::Invalid("clock is before the Unix epoch"))?
                .as_millis();
            let millis =
                i64::try_from(millis).map_err(|_| Error::Invalid("clock is out of range"))?;
            let id = match id {
                Some(id) => id.clone(),
                None => Id::new(table.clone(), uuid::Uuid::new_v4().simple().to_string())?,
            };
            self.catalog(false)?;
            let rid = id.record();
            let core = &self.state.storage;
            self.inner
                .get_or_add_tb(None, "tokamak", "tokamak", &rid.table, None)
                .await?;
            let row = Document {
                id: id.clone(),
                creation_time: millis,
                fields,
            };
            self.indexes(None, Some(&row)).await?;
            self.inner
                .put_record(
                    core.ns,
                    core.db,
                    &rid.table,
                    &rid.key,
                    Arc::new(Record::new(row.stored())),
                )
                .await?;
            self.written.insert(table.clone());
            self.record(None, Some(&row));
            Ok(id)
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
            let Value::Object(fields) = normalize(Value::Object(fields), 0)? else {
                unreachable!()
            };
            if fields == old.fields {
                return Ok(());
            }
            self.catalog(false)?;
            let persisted = Document {
                id: id.clone(),
                creation_time: old.creation_time,
                fields,
            };
            let rid = id.record();
            let core = &self.state.storage;
            self.indexes(Some(&old), Some(&persisted)).await?;
            self.inner
                .set_record(
                    core.ns,
                    core.db,
                    &rid.table,
                    &rid.key,
                    Arc::new(Record::new(persisted.stored())),
                )
                .await?;
            self.written.insert(id.table().clone());
            self.record(Some(&old), Some(&persisted));
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
            self.catalog(false)?;
            let rid = id.record();
            let core = &self.state.storage;
            self.indexes(Some(&old), None).await?;
            self.inner
                .del_record(core.ns, core.db, &rid.table, &rid.key)
                .await?;
            self.written.insert(id.table().clone());
            self.record(Some(&old), None);
            Ok(())
        }
        .await;
        self.finish(result)
    }

    /// Define a b-tree value index on application fields (including metadata).
    /// Existing rows cannot be backfilled here: a new definition on a nonempty
    /// table is rejected. Repeating the identical definition is a no-op.
    pub async fn define_index(
        &mut self,
        table: &Table,
        name: &str,
        fields: &[&str],
        unique: bool,
    ) -> Result<()> {
        let result = async {
            self.ready(true)?;
            check_field(name)?;
            if fields.is_empty() {
                return Err(Error::Invalid("an index needs at least one field"));
            }
            let mut seen = BTreeSet::new();
            for field in fields {
                check_field(field)?;
                if !seen.insert(*field) {
                    return Err(Error::Invalid("index fields must be distinct"));
                }
            }
            let core = &self.state.storage;
            let tb = TableName::from(table.as_str());
            self.inner
                .get_or_add_tb(None, "tokamak", "tokamak", &tb, None)
                .await?;
            let cols = fields
                .iter()
                .map(|field| {
                    // IndexOperation otherwise fans arrays out into element
                    // entries. Its trailing Flatten marker stores one whole
                    // value, keeping indexed eq consistent with Rust filtering.
                    surrealdb_idx::expr::Idiom(vec![
                        surrealdb_idx::expr::Part::Field((*field).into()),
                        surrealdb_idx::expr::Part::Flatten,
                    ])
                })
                .collect::<Vec<_>>();
            let kind = if unique { Index::Uniq } else { Index::Idx };
            if let Some(existing) = self
                .inner
                .get_tb_index(core.ns, core.db, &tb, name, None)
                .await?
            {
                return if existing.cols == cols && existing.index == kind {
                    Ok(())
                } else {
                    Err(Error::Invalid(
                        "a different index definition already uses that name",
                    ))
                };
            }
            self.catalog(true)?;
            let core = &self.state.storage;
            if self.inner.tb_has_records(core.ns, core.db, &tb).await? {
                return Err(Error::Invalid(
                    "cannot define an index on a table with rows; backfill is unsupported",
                ));
            }
            let index_id = core
                .sequences
                .next_index_id(None, core.ns, core.db, tb.clone())
                .await?;
            let index = IndexDefinition {
                index_id,
                name: name.into(),
                table_name: tb.clone(),
                cols,
                index: kind,
                count_cond: None,
                prepare_remove: false,
                format_version: surrealdb_idx::catalog::INDEX_FORMAT_VERSION,
                comment: None,
                nulls_not_distinct: false,
            };
            self.inner
                .put_tb_index(core.ns, core.db, &tb, &index)
                .await?;
            self.catalog_changed = true;
            Ok(())
        }
        .await;
        self.finish(result)
    }

    async fn indexes(&self, before: Option<&Document>, after: Option<&Document>) -> Result<()> {
        let row = after.or(before).expect("a mutation has a document");
        let core = &self.state.storage;
        let rid = row.id.record();
        let indexes = self
            .inner
            .all_tb_indexes(core.ns, core.db, &rid.table, None)
            .await?;
        if indexes.is_empty() {
            return Ok(());
        }
        let table = self.inner.expect_tb(core.ns, core.db, &rid.table).await?;
        let env = super::storage::IndexContext {
            tx: self.inner.clone(),
            core,
        };
        for index in indexes.iter() {
            let values = |document: &Document| -> Result<Vec<StoredValue>> {
                index
                    .cols
                    .iter()
                    .map(|column| {
                        let [
                            surrealdb_idx::expr::Part::Field(field),
                            surrealdb_idx::expr::Part::Flatten,
                        ] = column.0.as_slice()
                        else {
                            return Err(Error::Invalid("index is not a TokamakDB value index"));
                        };
                        Ok(StoredValue::from(super::query::field_value(
                            document,
                            field.as_str(),
                        )))
                    })
                    .collect()
            };
            let old = before.map(values).transpose()?;
            let new = after.map(values).transpose()?;
            let mut compaction = false;
            surrealdb_idx::index::IndexOperation::new(
                &env,
                core.ns,
                core.db,
                table.table_id,
                index,
                old,
                new,
                &rid,
            )
            .compute(&super::storage::NoAnalyzer, &mut compaction)
            .await?;
        }
        Ok(())
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
        let epoch = CommitEpoch {
            core: &self.state.storage,
            catalog: self.catalog_changed,
            writes: !self.written.is_empty(),
        };
        if self.read_only {
            // Read transactions have nothing to flush; the backend rejects a
            // read-only commit, while the application API permits it.
            self.inner.cancel().await?;
        } else {
            self.inner.commit().await?;
        }
        drop(epoch);
        if !self.written.is_empty() {
            // No receivers is normal before live subscriptions are installed.
            let _ = self.state.changes.send(ChangeEvent {
                tables: self.written.into_iter().collect(),
                records: self.changes,
            });
        }
        Ok(())
    }

    /// Await rollback explicitly; dropping the backend transaction is only a
    /// cancellation safety net, never a way to publish successful writes.
    pub async fn rollback(self) -> Result<()> {
        self.inner.cancel().await?;
        Ok(())
    }
}
