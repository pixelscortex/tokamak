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
// The schema is produced by plugin code, so its size is untrusted. Installing
// it runs natively under the catalog gate, outside the JS execution budget, and
// every installed index is maintained on every later write to its table. These
// caps bound that work before any transaction is opened. They limit one
// schema; indexes retained from removed declarations are not counted until
// dropping indexes exists.
const MAX_TABLES: usize = 256;
const MAX_INDEXES_PER_TABLE: usize = 32;
const MAX_INDEX_FIELDS: usize = 16;
const MAX_NAME_BYTES: usize = 64;

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
fn identifier(name: &str) -> bool {
    name.as_bytes()
        .first()
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn validate_index<'a>(
    table: &str,
    definition: &TableSchema,
    index: &'a Index,
    names: &mut BTreeSet<&'a String>,
) -> Result<(), Error> {
    if index.name.len() > MAX_NAME_BYTES {
        return Err(invalid(format!(
            "Invalid schema table {table}: index names are at most {MAX_NAME_BYTES} bytes"
        )));
    }
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
    if index.fields.len() > MAX_INDEX_FIELDS {
        return Err(fail("at most 16 fields are allowed"));
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
    Ok(())
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
        if schema.tables.len() > MAX_TABLES {
            return Err(invalid(format!(
                "Invalid plugin schema: at most {MAX_TABLES} tables are allowed"
            )));
        }
        for (table, definition) in &schema.tables {
            // Checked before the name is echoed, so an oversized name cannot
            // be copied into the error message.
            if table.len() > MAX_NAME_BYTES {
                return Err(invalid(format!(
                    "Invalid plugin schema: table names are at most {MAX_NAME_BYTES} bytes"
                )));
            }
            Table::new(table).map_err(|e| invalid(format!("Invalid schema table {table}: {e}")))?;
            if definition.indexes.len() > MAX_INDEXES_PER_TABLE {
                return Err(invalid(format!(
                    "Invalid schema table {table}: at most {MAX_INDEXES_PER_TABLE} indexes are allowed"
                )));
            }
            let mut names = BTreeSet::new();
            for index in &definition.indexes {
                validate_index(table, definition, index, &mut names)?;
            }
        }
        Ok(schema)
    }
    pub(crate) async fn apply(
        &self,
        tx: &mut Transaction,
        space: &DataSpace,
        startup: bool,
    ) -> Result<Option<String>, Error> {
        let Some(reason) = self.apply_indexes(tx, space).await? else {
            return Ok(None);
        };
        if !startup {
            return Err(invalid(reason));
        }

        // Replace this startup-only hard reset with migrations once supported.
        let declared = self.tables.keys().map(String::as_str).collect();
        Box::pin(tx.reset_schema_space(space, &declared))
            .await
            .map_err(|e| invalid(format!("{reason}; schema reset failed: {e}")))?;
        if let Some(incompatibility) = self.apply_indexes(tx, space).await? {
            return Err(invalid(incompatibility));
        }
        Ok(Some(reason))
    }

    async fn apply_indexes(
        &self,
        tx: &mut Transaction,
        space: &DataSpace,
    ) -> Result<Option<String>, Error> {
        for (name, definition) in &self.tables {
            let table = space
                .table(&Table::new(name).map_err(|e| invalid(e.to_string()))?)
                .map_err(|e| invalid(e.to_string()))?;
            for index in &definition.indexes {
                let fields = index.fields.iter().map(String::as_str).collect::<Vec<_>>();
                let context = |reason: &str| {
                    format!(
                        "Plugin {} schema index {name}.{}: {reason}",
                        space.owner().unwrap_or("<legacy>"),
                        index.name
                    )
                };
                let conflict =
                    Box::pin(tx.try_define_index(&table, &index.name, &fields, index.unique))
                        .await
                        .map_err(|e| invalid(context(&e.to_string())))?;
                if let Some(reason) = conflict {
                    return Ok(Some(context(reason)));
                }
            }
        }
        Ok(None)
    }
}

pub(crate) fn log_reset(reason: &str) {
    eprintln!("Schema hard reset: wiped stored data for {reason}");
}
