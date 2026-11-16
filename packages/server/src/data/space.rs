//! Logical plugin IDs never become physical table names without host mediation.
use super::{Document, Error, Id, Result, Table};
use super::{Object, SurrealValue, Value};

pub fn json_object(value: &serde_json::Value) -> Result<Object> {
    match value.clone().into_value() {
        Value::Object(object) => Ok(object),
        _ => Err(Error::Invalid("document must be a JSON object")),
    }
}

#[derive(Clone, Debug, Default)]
pub struct DataSpace {
    plugin: Option<String>,
    prefix: String,
}
impl DataSpace {
    /// Default is the legacy single-feature space, retained for POC fixtures.
    /// Plugin loading must use this constructor, never an author-supplied prefix.
    pub fn plugin(id: &str) -> Result<Self> {
        if id.is_empty()
            || !id.as_bytes()[0].is_ascii_lowercase()
            || !id.bytes().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
            })
            || id.split(['.', '_', '-']).any(str::is_empty)
        {
            return Err(Error::Invalid("invalid plugin identity"));
        }
        // Hex encoding is injective: acme.notes cannot collide with acme_notes.
        let mut prefix = String::from("p");
        for byte in id.bytes() {
            use std::fmt::Write;
            write!(prefix, "{byte:02x}").expect("writing to a string");
        }
        prefix.push_str("__");
        Ok(Self {
            plugin: Some(id.into()),
            prefix,
        })
    }
    pub(crate) fn host() -> Self {
        Self {
            plugin: None,
            prefix: "h__".into(),
        }
    }

    pub fn owner(&self) -> Option<&str> {
        self.plugin.as_deref()
    }
    pub fn table(&self, logical: &Table) -> Result<Table> {
        Table::new(format!("{}{}", self.prefix, logical.as_str()))
    }
    pub fn id(&self, text: &str) -> Result<Id> {
        let logical = if let Some((owner, id)) = text.split_once('/') {
            if self.plugin.as_deref() != Some(owner) {
                return Err(Error::AccessDenied);
            }
            id
        } else {
            text
        };
        let id: Id = logical.parse()?;
        Id::new(self.table(id.table())?, id.key())
    }
    pub fn present_id(&self, physical: &Id) -> Result<String> {
        let logical = physical
            .table()
            .as_str()
            .strip_prefix(&self.prefix)
            .ok_or(Error::AccessDenied)?;
        let id = format!("{logical}:{}", physical.key());
        Ok(match &self.plugin {
            Some(plugin) => format!("{plugin}/{id}"),
            None => id,
        })
    }
    pub fn document(&self, document: Document) -> Result<serde_json::Value> {
        let id = self.present_id(&document.id)?;
        let mut value = document.into_json();
        value
            .as_object_mut()
            .expect("document")
            .insert("_id".into(), id.into());
        Ok(value)
    }
}
