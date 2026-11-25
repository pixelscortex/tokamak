use super::*;
use crate::data::{DataSpace, Document, Value};
use std::collections::BTreeMap;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Reference {
    pub source: Table,
    pub field: String,
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
        fn matching(
            registry: &References,
            predicate: impl Fn(&Reference) -> bool,
        ) -> Vec<Reference> {
            registry
                .values()
                .flatten()
                .filter(|reference| predicate(reference))
                .cloned()
                .collect()
        }

        if let Some(registry) = &self.references {
            matching(registry, predicate)
        } else {
            matching(
                &self.state.storage.references.read().expect("references"),
                predicate,
            )
        }
    }

    pub(super) async fn validate_references(&mut self, row: &Document) -> Result<()> {
        let outgoing = self.references_matching(|reference| &reference.source == row.id.table());
        if outgoing.is_empty() {
            return Ok(());
        }
        // Serialize checks and cascades so neither can miss the other's writes.
        self.catalog(true)?;
        for reference in outgoing {
            let Some(value) = row.fields.get(&reference.field) else {
                if reference.optional {
                    continue;
                }
                return Err(Error::Invalid("required reference field is missing"));
            };
            let Value::String(text) = value else {
                return Err(Error::Invalid(
                    "reference must be an id of the declared table",
                ));
            };
            if text.split_once('/').map(|(owner, _)| owner) != reference.space.owner() {
                return Err(Error::Invalid(
                    "reference must be an id of the declared table",
                ));
            }
            let id = reference.space.id(text)?;
            if id.table() != &reference.target {
                return Err(Error::Invalid(
                    "reference must be an id of the declared table",
                ));
            }
            if Box::pin(self.get(&id)).await?.is_none() {
                return Err(Error::Invalid("referenced row does not exist"));
            }
        }
        Ok(())
    }

    pub(super) async fn referring_rows(&mut self, id: &Id) -> Result<Vec<Id>> {
        let incoming = self.references_matching(|reference| &reference.target == id.table());
        if incoming.is_empty() {
            return Ok(Vec::new());
        }
        self.catalog(true)?;

        let mut sources = BTreeMap::<_, Vec<_>>::new();
        for reference in incoming {
            let value = Value::String(reference.space.present_id(id)?);
            sources
                .entry(reference.source)
                .or_default()
                .push((reference.field, value));
        }

        let mut ids = Vec::new();
        for (table, fields) in sources {
            for row in self.scan_table(&table).await? {
                if fields
                    .iter()
                    .any(|(field, value)| row.fields.get(field) == Some(value))
                {
                    ids.push(row.id);
                }
            }
        }
        Ok(ids)
    }
}
