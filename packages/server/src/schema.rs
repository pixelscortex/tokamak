//! Bundle schema registry. Field descriptions are metadata, not write validators.
use crate::{
    Error,
    data::{DataSpace, Table, Transaction},
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Deserialize)]
pub(crate) struct Schema {
    #[serde(default)]
    tables: BTreeMap<String, TableSchema>,
}
#[derive(Deserialize)]
struct TableSchema {
    #[serde(default)]
    description: Value,
    #[serde(default)]
    indexes: Vec<Index>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    name: String,
    fields: Vec<String>,
    unique: bool,
}
fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
fn identifier(name: &str) -> bool {
    name.as_bytes()
        .first()
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
impl Schema {
    pub(crate) fn parse(value: &Value) -> Result<Self, Error> {
        // Legacy bundles without a schema exported null (or {}).
        let schema: Self = if value.is_null() {
            Self::default()
        } else {
            serde_json::from_value(value.clone())
                .map_err(|e| invalid(format!("Invalid plugin schema: {e}")))?
        };
        for (table, definition) in &schema.tables {
            Table::new(table).map_err(|e| invalid(format!("Invalid schema table {table}: {e}")))?;
            let mut names = BTreeSet::new();
            for index in &definition.indexes {
                let fail = |reason| {
                    invalid(format!(
                        "Invalid schema index {table}.{}: {reason}",
                        index.name
                    ))
                };
                if !identifier(&index.name) {
                    return Err(fail("name must match [A-Za-z_][A-Za-z0-9_]*"));
                }
                if !names.insert(&index.name) {
                    return Err(fail("duplicate name"));
                }
                if index.fields.is_empty() {
                    return Err(fail("at least one field is required"));
                }
                let mut fields = BTreeSet::new();
                for field in &index.fields {
                    if !identifier(field)
                        || field == "_id"
                        || field == "_creationTime"
                        || definition.description["kind"] != "object"
                        || !definition.description["fields"]
                            .as_object()
                            .is_some_and(|f| f.contains_key(field))
                    {
                        return Err(fail("fields must be declared top-level ASCII identifiers"));
                    }
                    if !fields.insert(field) {
                        return Err(fail("repeated field"));
                    }
                }
            }
        }
        Ok(schema)
    }
    pub(crate) async fn apply(&self, tx: &mut Transaction, space: &DataSpace) -> Result<(), Error> {
        for (name, definition) in &self.tables {
            let table = space
                .table(&Table::new(name).map_err(|e| invalid(e.to_string()))?)
                .map_err(|e| invalid(e.to_string()))?;
            for index in &definition.indexes {
                let fields = index.fields.iter().map(String::as_str).collect::<Vec<_>>();
                // define_index compares the complete catalog definition before
                // checking for rows, under the existing gate/epoch contract.
                Box::pin(tx.define_index(&table, &index.name, &fields, index.unique))
                    .await
                    .map_err(|e| {
                        invalid(format!(
                            "Plugin {} schema index {name}.{}: {e}",
                            space.owner().unwrap_or("<legacy>"),
                            index.name
                        ))
                    })?;
            }
            // Removed declarations deliberately leave catalog indexes in place:
            // dropping indexes and migration/backfill belong to later work.
        }
        Ok(())
    }
}
