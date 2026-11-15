use super::*;
use crate::data::types::check_field;
use surrealdb_idx::catalog::{Index, IndexDefinition, providers::*};
use surrealdb_idx::val::{TableName, Value as StoredValue};

impl Transaction {
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
            tx.inner
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
            if let Some(existing) = tx
                .inner
                .get_tb_index(core.ns, core.db, &tb, name, None)
                .await?
            {
                return if existing.cols == cols && existing.index == kind {
                    Ok(())
                } else {
                    Err(Error::Invalid(
                        "a different index definition already uses that name; index backfill is not supported yet",
                    ))
                };
            }
            tx.catalog(true)?;
            let core = &tx.state.storage;
            if tx.inner.tb_has_records(core.ns, core.db, &tb).await? {
                return Err(Error::Invalid(
                    "cannot define an index on a table with rows; index backfill is not supported yet",
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
            tx.inner.put_tb_index(core.ns, core.db, &tb, &index).await?;
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
        let indexes = self.inner.all_tb_indexes(core.ns, core.db, &rid.table, None).await?;
        if indexes.is_empty() {
            return Ok(());
        }
        let table = self.inner.expect_tb(core.ns, core.db, &rid.table).await?;
        let env = crate::data::storage::IndexContext {
            tx: self.inner.clone(),
            core,
        };
        for index in indexes.iter() {
            let old = before.map(|document| index_values(index, document)).transpose()?;
            let new = after.map(|document| index_values(index, document)).transpose()?;
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

fn index_values(index: &IndexDefinition, document: &Document) -> Result<Vec<StoredValue>> {
    index
        .cols
        .iter()
        .map(|column| {
            let [surrealdb_idx::expr::Part::Field(field), surrealdb_idx::expr::Part::Flatten] =
                column.0.as_slice()
            else {
                return Err(Error::Invalid("index is not a TokamakDB value index"));
            };
            Ok(StoredValue::from(crate::data::query::field_value(document, field.as_str())))
        })
        .collect()
}
