use super::*;
use crate::data::{
    Object, Value,
    types::{check_fields, normalize},
};
use std::{
    borrow::Cow,
    time::{SystemTime, UNIX_EPOCH},
};
use surrealdb_datastore::key::schema::{RecordKey, RecordPrefix};
use surrealdb_idx::{
    catalog::{Record, providers::*},
    val::{TableName, Value as StoredValue},
};
use surrealdb_kvs::key::KVKeyDecode;

impl Transaction {
    /// Cancelling a read leaves the transaction usable: reads stage no writes.
    /// A returned read error still poisons the transaction.
    pub async fn get(&mut self, id: &Id) -> Result<Option<Document>> {
        let result = async {
            self.ready(false)?;

            let core = &self.state.storage;

            let rid = id.record();

            let record =
                self.inner.get_record(core.ns, core.db, &rid.table, &rid.key, None).await?;

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
    pub(in crate::data) async fn scan_table(&self, table: &Table) -> Result<Vec<Document>> {
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

            let record = self.inner.get_record(core.ns, core.db, &table, &key.id, None).await?;
            documents.push(Document::decode(record.data.clone())?);
        }

        Ok(documents)
    }

    /// Mutations that error or are dropped after polling poison the transaction.
    /// Only rollback is then allowed; commit discards all staged writes.
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
        let mutation = Mutation::new(self);

        let tx = &mut *mutation.tx;

        let result = async {
            tx.ready(true)?;
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
            tx.catalog(false)?;

            let rid = id.record();

            let core = &tx.state.storage;
            tx.inner.get_or_add_tb(None, "tokamak", "tokamak", &rid.table, None).await?;

            let row = Document {
                id: id.clone(),
                creation_time: millis,
                fields,
            };
            tx.indexes(None, Some(&row)).await?;
            tx.inner
                .put_record(
                    core.ns,
                    core.db,
                    &rid.table,
                    &rid.key,
                    Arc::new(Record::new(row.stored())),
                )
                .await?;
            tx.written.insert(table.clone());
            tx.record(None, Some(&row));

            Ok(id)
        }
        .await;
        mutation.finish(result)
    }

    pub async fn patch(&mut self, id: &Id, value: Object) -> Result<()> {
        self.update(id, value, false).await
    }

    pub async fn replace(&mut self, id: &Id, value: Object) -> Result<()> {
        self.update(id, value, true).await
    }

    async fn update(&mut self, id: &Id, value: Object, replace: bool) -> Result<()> {
        let mutation = Mutation::new(self);

        let tx = &mut *mutation.tx;

        let result = async {
            tx.ready(true)?;
            check_fields(&value)?;

            let old = tx.get(id).await?.ok_or(Error::MissingRecord)?;

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
            tx.catalog(false)?;

            let persisted = Document {
                id: id.clone(),
                creation_time: old.creation_time,
                fields,
            };

            let rid = id.record();

            let core = &tx.state.storage;
            tx.indexes(Some(&old), Some(&persisted)).await?;
            tx.inner
                .set_record(
                    core.ns,
                    core.db,
                    &rid.table,
                    &rid.key,
                    Arc::new(Record::new(persisted.stored())),
                )
                .await?;
            tx.written.insert(id.table().clone());
            tx.record(Some(&old), Some(&persisted));

            Ok(())
        }
        .await;
        mutation.finish(result)
    }

    /// Deleting an absent record is a no-op and must not report its table.
    pub async fn delete(&mut self, id: &Id) -> Result<()> {
        let mutation = Mutation::new(self);

        let tx = &mut *mutation.tx;

        let result = async {
            tx.ready(true)?;

            let Some(old) = tx.get(id).await? else {
                return Ok(());
            };
            tx.catalog(false)?;

            let rid = id.record();

            let core = &tx.state.storage;
            tx.indexes(Some(&old), None).await?;
            tx.inner.del_record(core.ns, core.db, &rid.table, &rid.key).await?;
            tx.written.insert(id.table().clone());
            tx.record(Some(&old), None);

            Ok(())
        }
        .await;
        mutation.finish(result)
    }
}
