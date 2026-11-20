use super::*;
use crate::data::{DataSpace, types::check_field};
use std::{borrow::Cow, collections::BTreeMap};
use surrealdb_datastore::key::schema::RecordPrefix;
use surrealdb_idx::catalog::{Index, IndexDefinition, TableId, providers::*};
use surrealdb_idx::val::{TableName, Value as StoredValue};

impl Transaction {
    /// Define a b-tree value index on application fields (including metadata).
    /// Backfill existing rows in this transaction. Repeating an identical
    /// definition is a no-op; changing it replaces the old index.
    pub async fn define_index(
        &mut self,
        table: &Table,
        name: &str,
        fields: &[&str],
        unique: bool,
    ) -> Result<()> {
        let mutation = Mutation::new(self);

        let tx = &mut *mutation.tx;

        let result = async {
            tx.ready(true)?;
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

            let core = &tx.state.storage;

            let tb = TableName::from(table.as_str());
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

            let kind = if unique {
                Index::Uniq
            } else {
                Index::Idx
            };

            let existing = tx
                .inner
                .get_tb_index(core.ns, core.db, &tb, name, None)
                .await?;
            if existing
                .as_ref()
                .is_some_and(|index| index.cols == cols && index.index == kind)
            {
                return Ok(());
            }
            tx.catalog(true)?;

            let core = &tx.state.storage;
            if existing.is_some() {
                tx.inner.del_tb_index(core.ns, core.db, &tb, name).await?;
            }
            let definition = tx
                .inner
                .get_or_add_tb(None, "tokamak", "tokamak", &tb, None)
                .await?;
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
            tx.inner.put_tb_index(core.ns, core.db, &tb, &index).await?;
            tx.catalog_changed = true;

            Box::pin(tx.backfill_index(table, definition.table_id, &index)).await
        }
        .await;
        mutation.finish(result)
    }

    async fn backfill_index(
        &self,
        table: &Table,
        table_id: TableId,
        index: &IndexDefinition,
    ) -> Result<()> {
        let core = &self.state.storage;
        let env = crate::data::storage::IndexContext {
            tx: self.inner.clone(),
            core,
        };
        for row in self.scan_table(table).await? {
            let values = index_values(index, &row)?;
            surrealdb_idx::index::IndexOperation::new(
                &env,
                core.ns,
                core.db,
                table_id,
                index,
                None,
                Some(values),
                &row.id.record(),
            )
            .compute(&crate::data::storage::NoAnalyzer, &mut false)
            .await
            .map_err(backfill_error)?;
        }
        Ok(())
    }

    pub(crate) async fn drop_undeclared_indexes(
        &mut self,
        space: &DataSpace,
        declared: &BTreeMap<&str, BTreeSet<&str>>,
    ) -> Result<()> {
        let mutation = Mutation::new(self);
        let tx = &mut *mutation.tx;
        let result = async {
            tx.ready(true)?;
            let tables = declared.keys().copied().collect();
            let core = &tx.state.storage;
            let mut obsolete = Vec::new();
            for table in tx.inner.all_tb(core.ns, core.db, None).await?.iter() {
                let tb = &table.name;
                if !space.owns_schema_table(tb.as_str(), &tables) {
                    continue;
                }
                let names = declared.get(tb.as_str());
                let indexes = tx.inner.all_tb_indexes(core.ns, core.db, tb, None).await?;
                obsolete.extend(
                    indexes
                        .iter()
                        .filter(|index| {
                            !names.is_some_and(|names| names.contains(index.name.as_str()))
                        })
                        .map(|index| (tb.clone(), index.name.clone())),
                );
            }
            if !obsolete.is_empty() {
                tx.catalog(true)?;
                let core = &tx.state.storage;
                for (table, index) in obsolete {
                    tx.inner
                        .del_tb_index(core.ns, core.db, &table, &index)
                        .await?;
                }
                tx.catalog_changed = true;
            }
            Ok(())
        }
        .await;
        mutation.finish(result)
    }

    pub(crate) async fn reset_schema_space(
        &mut self,
        space: &DataSpace,
        declared: &BTreeSet<&str>,
    ) -> Result<()> {
        let mutation = Mutation::new(self);
        let tx = &mut *mutation.tx;
        let result = async {
            tx.ready(true)?;
            tx.catalog(true)?;
            let core = &tx.state.storage;
            for table in tx.inner.all_tb(core.ns, core.db, None).await?.iter() {
                let tb = &table.name;
                if !space.owns_schema_table(tb.as_str(), declared) {
                    continue;
                }
                let indexes = tx.inner.all_tb_indexes(core.ns, core.db, tb, None).await?;
                for index in indexes.iter() {
                    tx.inner
                        .del_tb_index(core.ns, core.db, tb, &index.name)
                        .await?;
                }
                let records = RecordPrefix {
                    ns: core.ns,
                    db: core.db,
                    tb: Cow::Borrowed(tb),
                };
                tx.inner.delr(records.range()?).await?;
            }
            tx.catalog_changed = true;
            Ok(())
        }
        .await;
        mutation.finish(result)
    }

    pub(super) async fn indexes(
        &self,
        before: Option<&Document>,
        after: Option<&Document>,
    ) -> Result<()> {
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

        let env = crate::data::storage::IndexContext {
            tx: self.inner.clone(),
            core,
        };

        for index in indexes.iter() {
            let old = before
                .map(|document| index_values(index, document))
                .transpose()?;

            let new = after
                .map(|document| index_values(index, document))
                .transpose()?;

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
            .compute(&crate::data::storage::NoAnalyzer, &mut compaction)
            .await?;
        }

        Ok(())
    }
}

fn backfill_error(error: anyhow::Error) -> Error {
    if let Some(surrealdb_idx::Error::IndexExists { index, value, .. }) = error.downcast_ref() {
        return Error::BackfillUniqueViolation {
            index: index.clone(),
            value: value.clone(),
        };
    }
    error.into()
}

fn index_values(index: &IndexDefinition, document: &Document) -> Result<Vec<StoredValue>> {
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

            Ok(StoredValue::from(crate::data::query::field_value(
                document,
                field.as_str(),
            )))
        })
        .collect()
}
