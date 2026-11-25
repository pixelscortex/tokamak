//! Bundle schema registry. Indexes and typed references are enforced by the data layer.
use crate::{
    Error,
    data::{DataSpace, REF_INDEX_PREFIX, Reference, Table, Transaction},
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
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
// caps bound the declarations before any transaction is opened.
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
        let references = self.references(space)?;
        let Some(reason) = self.apply_indexes(tx, space, &references).await? else {
            tx.set_references(space, references).map_err(data_error)?;
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
        if let Some(incompatibility) = self.apply_indexes(tx, space, &references).await? {
            return Err(invalid(incompatibility));
        }
        tx.set_references(space, references).map_err(data_error)?;
        Ok(Some(reason))
    }

    fn references(&self, space: &DataSpace) -> Result<Vec<Reference>, Error> {
        let mut references = Vec::new();
        for (table, definition) in &self.tables {
            let Some(fields) = definition.description["fields"].as_object() else {
                continue;
            };
            for (field, description) in fields {
                let optional = description["kind"] == "optional";
                let description = if optional {
                    &description["inner"]
                } else {
                    description
                };
                if description["kind"] != "ref" && contains_ref(description) {
                    return Err(invalid(format!(
                        "Ref {table}.{field} must be a top-level table field"
                    )));
                }
                if description["kind"] != "ref" {
                    continue;
                }
                let (owner, target) = description["table"]
                    .as_str()
                    .and_then(|table| table.rsplit_once('.'))
                    .ok_or_else(|| {
                        invalid(format!(
                            "Invalid ref {table}.{field}: expected plugin.table"
                        ))
                    })?;
                let target_space = DataSpace::plugin(owner).map_err(data_error)?;
                references.push(Reference {
                    source: space
                        .table(&Table::new(table).map_err(data_error)?)
                        .map_err(data_error)?,
                    field: field.clone(),
                    index: definition
                        .indexes
                        .iter()
                        .find(|index| index.fields.first() == Some(field))
                        .map_or_else(
                            || format!("{REF_INDEX_PREFIX}{:x}", Sha256::digest(field)),
                            |index| index.name.clone(),
                        ),
                    target: target_space
                        .table(&Table::new(target).map_err(data_error)?)
                        .map_err(data_error)?,
                    space: target_space,
                    optional,
                });
            }
        }
        Ok(references)
    }

    async fn apply_indexes(
        &self,
        tx: &mut Transaction,
        space: &DataSpace,
        references: &[Reference],
    ) -> Result<Option<String>, Error> {
        let mut declared = BTreeMap::new();
        for (name, definition) in &self.tables {
            let table = space
                .table(&Table::new(name).map_err(|e| invalid(e.to_string()))?)
                .map_err(|e| invalid(e.to_string()))?;
            declared.insert(table, (name, definition));
        }

        let mut names: BTreeMap<_, BTreeSet<_>> = declared
            .iter()
            .map(|(table, (_, definition))| {
                (
                    table.as_str(),
                    definition
                        .indexes
                        .iter()
                        .map(|index| index.name.as_str())
                        .collect(),
                )
            })
            .collect();
        for reference in references {
            names
                .entry(reference.source.as_str())
                .or_default()
                .insert(&reference.index);
        }
        Box::pin(tx.drop_undeclared_indexes(space, &names))
            .await
            .map_err(|e| invalid(e.to_string()))?;

        for (table, (name, definition)) in &declared {
            for index in &definition.indexes {
                let fields = index.fields.iter().map(String::as_str).collect::<Vec<_>>();
                Box::pin(tx.define_index(table, &index.name, &fields, index.unique))
                    .await
                    .map_err(|error| index_error(space, name, &index.name, error))?;
            }
        }
        for reference in references
            .iter()
            .filter(|r| r.index.starts_with(REF_INDEX_PREFIX))
        {
            Box::pin(tx.define_ref_index(&reference.source, &reference.index, &reference.field))
                .await
                .map_err(data_error)?;
        }
        // Index edits never request a reset. Keep the startup reset path for
        // schema incompatibilities that cannot be applied to the stored data.
        Ok(None)
    }
}

fn data_error(error: crate::data::Error) -> Error {
    invalid(error.to_string())
}

fn contains_ref(description: &Value) -> bool {
    match description["kind"].as_str() {
        Some("ref") => true,
        Some("array") => contains_ref(&description["item"]),
        Some("optional") => contains_ref(&description["inner"]),
        Some("object") => description["fields"]
            .as_object()
            .is_some_and(|fields| fields.values().any(contains_ref)),
        Some("union") => description["members"]
            .as_array()
            .is_some_and(|members| members.iter().any(contains_ref)),
        _ => false,
    }
}

fn index_error(space: &DataSpace, table: &str, index: &str, error: crate::data::Error) -> Error {
    let plugin = space.owner().unwrap_or("<legacy>");
    let message = format!("Plugin {plugin} schema index {table}.{index}: {error}");
    if matches!(error, crate::data::Error::BackfillUniqueViolation { .. }) {
        return Error::IndexBackfill(message);
    }
    invalid(message)
}

pub(crate) fn log_reset(reason: &str) {
    eprintln!("Schema hard reset: wiped stored data for {reason}");
}
