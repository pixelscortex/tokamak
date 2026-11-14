//! Boundary types keep data separate from SQL syntax and storage metadata.
//! The POC intentionally accepts a narrow, SDK-compatible ID spelling instead
//! of parsing record expressions. JSON-like public values cross the internal
//! storage boundary explicitly; no parser or execution engine is involved.

use std::{fmt, str::FromStr};
use surrealdb_idx::val::{RecordId, Value as StoredValue};
use surrealdb_types::{Number, Object, Value};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Database(anyhow::Error),
    UniqueViolation { index: String },
    Startup(String),
    Invalid(&'static str),
    ReadOnly,
    AccessDenied,
    FailedTransaction,
    MissingRecord,
    Busy,
    Closed,
}

impl Error {
    /// No message matching and no automatic retries of arbitrary commit errors.
    pub fn is_retryable_conflict(&self) -> bool {
        matches!(self, Self::Database(error)
            if matches!(error.downcast_ref::<surrealdb_kvs::err::Error>(),
                Some(surrealdb_kvs::err::Error::TransactionConflict(_))))
    }
}

impl From<anyhow::Error> for Error {
    fn from(error: anyhow::Error) -> Self {
        if let Some(
            surrealdb_idx::Error::IndexExists { index, .. }
            | surrealdb_idx::Error::IndexExistsHidden { index },
        ) = error.downcast_ref()
        {
            return Self::UniqueViolation {
                index: index.clone(),
            };
        }
        Self::Database(error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::UniqueViolation { index } => {
                write!(f, "unique index `{index}` already contains that value")
            }
            Self::Startup(message) => f.write_str(message),
            Self::Invalid(message) => f.write_str(message),
            Self::ReadOnly => f.write_str("read-only transactions cannot write"),
            Self::AccessDenied => f.write_str("plugin data space does not own that record"),
            Self::FailedTransaction => {
                f.write_str("an earlier operation failed; roll back this transaction")
            }
            Self::MissingRecord => f.write_str("the record does not exist"),
            Self::Busy => {
                f.write_str("active transactions must finish before closing the database")
            }
            Self::Closed => f.write_str("the database is closed"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error.as_ref()),
            _ => None,
        }
    }
}

/// ASCII table names form the stable application identifier format.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Table(String);

impl Table {
    pub fn new(name: impl Into<String>) -> Result<Self> {
        let name = name.into();
        if !name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            return Err(Error::Invalid("table must match [A-Za-z][A-Za-z0-9_]*"));
        }
        Ok(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Keys are opaque strings, including all-digit keys; never parsed as SQL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Id {
    table: Table,
    key: String,
}

impl Id {
    pub fn new(table: Table, key: impl Into<String>) -> Result<Self> {
        let key = key.into();
        if key.is_empty()
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        {
            return Err(Error::Invalid("record key must match [A-Za-z0-9_-]+"));
        }
        Ok(Self { table, key })
    }

    pub fn table(&self) -> &Table {
        &self.table
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn record(&self) -> RecordId {
        RecordId {
            table: self.table.as_str().into(),
            key: self.key.clone().into(),
        }
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.table.as_str(), self.key)
    }
}

impl FromStr for Id {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        let (table, key) = text
            .split_once(':')
            .ok_or(Error::Invalid("id must be table:key"))?;
        Self::new(Table::new(table)?, key)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub enum Order {
    #[default]
    Asc,
    Desc,
}

/// Metadata is separate so callers cannot patch identity or creation time.
/// The JS adapter flattens these to `_id`, `_creationTime`, and the fields.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub id: Id,
    pub creation_time: i64,
    pub fields: Object,
}

impl Document {
    pub(crate) fn decode(value: StoredValue) -> Result<Self> {
        let value = Value::try_from(value)?;
        let Value::Object(mut fields) = value else {
            return Err(Error::Invalid("stored document is not an object"));
        };
        let Some(Value::RecordId(id)) = fields.remove("id") else {
            return Err(Error::Invalid("stored document has no record id"));
        };
        let Some(Value::Number(Number::Int(creation_time))) = fields.remove("_creationTime") else {
            return Err(Error::Invalid(
                "stored document has no integer creation time",
            ));
        };
        // User fields live under `data`, so ordinary business fields named
        // `id` or `data` never collide with SurrealDB's native record identity.
        let Some(Value::Object(fields)) = fields.remove("data") else {
            return Err(Error::Invalid("stored document has no data object"));
        };
        Ok(Self {
            id: Id::new(
                Table::new(id.table.as_str())?,
                match id.key {
                    surrealdb_types::RecordIdKey::String(key) => key,
                    _ => return Err(Error::Invalid("stored record has a non-string key")),
                },
            )?,
            creation_time,
            fields,
        })
    }
}

pub(crate) fn check_fields(fields: &Object) -> Result<()> {
    // These are the SDK's reserved metadata names, not SurrealDB's names.
    if ["_id", "_creationTime"]
        .iter()
        .any(|key| fields.contains_key(*key))
    {
        return Err(Error::Invalid("document system fields cannot be written"));
    }
    Ok(())
}

pub(crate) fn check_field(field: &str) -> Result<()> {
    if !field
        .as_bytes()
        .first()
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
        || !field
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return Err(Error::Invalid(
            "filter field must be a single ASCII identifier",
        ));
    }
    Ok(())
}

/// Normalize before comparing or indexing, so NONE-only edits remain no-ops.
/// The depth bound also prevents untrusted host values exhausting the Rust stack.
pub(crate) fn normalize(value: Value, depth: usize) -> Result<Value> {
    if depth > 128 {
        return Err(Error::Database(anyhow::anyhow!(
            "document nesting exceeds 128 levels"
        )));
    }
    Ok(match value {
        Value::Object(object) => {
            let mut normalized = Object::new();
            for (key, value) in object {
                if value != Value::None {
                    normalized.insert(key, normalize(value, depth + 1)?);
                }
            }
            Value::Object(normalized)
        }
        Value::Array(array) => Value::Array(
            array
                .into_iter()
                .map(|value| normalize(value, depth + 1))
                .collect::<Result<Vec<_>>>()?
                .into(),
        ),
        Value::None | Value::Null | Value::Bool(_) | Value::String(_) => value,
        Value::Number(Number::Int(_)) => value,
        Value::Number(Number::Float(number)) if number.is_finite() => value,
        _ => return Err(Error::Invalid("document values must be JSON-like")),
    })
}

impl Document {
    pub(crate) fn stored(&self) -> StoredValue {
        let mut envelope = Object::new();
        envelope.insert(
            "id",
            Value::RecordId(surrealdb_types::RecordId::new(
                self.id.table().as_str(),
                self.id.key(),
            )),
        );
        envelope.insert("_creationTime", self.creation_time);
        envelope.insert("data", self.fields.clone());
        StoredValue::from(Value::Object(envelope))
    }
}
