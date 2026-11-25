use super::*;
use crate::data::{DataSpace, Document, Value};
use std::collections::BTreeMap;
use surrealdb_idx::{catalog::providers::*, val::Value as StoredValue};

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Reference {
    pub source: Table,
    pub field: String,
    pub index: String,
    pub target: Table,
    pub space: DataSpace,
    pub optional: bool,
}

pub(in crate::data) type References = BTreeMap<Option<String>, Vec<Reference>>;

impl Transaction {
    pub(crate) fn set_references(
        &mut self,
        space: &DataSpace,
        references: Vec<Reference>,
    ) -> Result<()> {
        let owner = space.owner().map(str::to_owned);
        let registry = self.reference_registry();
        if registry.get(&owner).map(Vec::as_slice).unwrap_or_default() == references {
            return Ok(());
        }

        self.catalog(true)?;
        let staged = self.references.get_or_insert(registry);
        if references.is_empty() {
            staged.remove(&owner);
        } else {
            staged.insert(owner, references);
        }
        self.catalog_changed = true;
        Ok(())
    }

    fn reference_registry(&self) -> References {
        self.references.as_ref().cloned().unwrap_or_else(|| {
            self.state
                .storage
                .references
                .read()
                .expect("references")
                .clone()
        })
    }

    fn references_matching(&self, predicate: impl Fn(&Reference) -> bool) -> Vec<Reference> {
        let committed;
        let registry = match &self.references {
            Some(staged) => staged,
            None => {
                committed = self.state.storage.references.read().expect("references");
                &committed
            }
        };
        registry
            .values()
            .flatten()
            .filter(|reference| predicate(reference))
            .cloned()
            .collect()
    }

    pub(super) async fn validate_references(
        &self,
        before: Option<&Document>,
        after: &Document,
    ) -> Result<()> {
        let outgoing = self.references_matching(|reference| &reference.source == after.id.table());
        for reference in outgoing {
            let value = after.fields.get(&reference.field);
            if before.is_some_and(|row| row.fields.get(&reference.field) == value) {
                continue;
            }
            let Some(value) = value else {
                if reference.optional {
                    continue;
                }
                return Err(Error::Invalid("required reference field is missing"));
            };

            let id = reference.target_id(value).ok_or(Error::Invalid(
                "reference must be an id of the declared table",
            ))?;
            self.guard_target(&id).await?;
        }
        Ok(())
    }

    async fn guard_target(&self, id: &Id) -> Result<()> {
        let core = &self.state.storage;
        let rid = id.record();
        let record = self
            .inner
            .get_record(core.ns, core.db, &rid.table, &rid.key, None)
            .await?;
        if record.data == StoredValue::None {
            return Err(Error::Invalid("referenced row does not exist"));
        }

        // A same-value write makes a concurrent delete conflict on this key.
        self.inner
            .set_record(core.ns, core.db, &rid.table, &rid.key, record)
            .await?;
        Ok(())
    }

    pub(super) async fn referring_rows(&mut self, id: &Id) -> Result<Vec<Id>> {
        let incoming = self.references_matching(|reference| &reference.target == id.table());
        let mut ids = Vec::new();

        for reference in incoming {
            let value = reference.space.present_id(id)?;
            let rows = self
                .query(&reference.source)
                .matching_index(&reference.index, &reference.field, value)
                .await?;
            ids.extend(rows.into_iter().map(|row| row.id));
        }
        Ok(ids)
    }
}

impl Reference {
    fn target_id(&self, value: &Value) -> Option<Id> {
        let Value::String(text) = value else {
            return None;
        };
        let (owner, _) = text.split_once('/')?;
        if Some(owner) != self.space.owner() {
            return None;
        }

        let id = self.space.id(text).ok()?;
        (id.table() == &self.target).then_some(id)
    }
}

#[cfg(test)]
#[path = "../../../tests/internal/references.rs"]
mod tests;
