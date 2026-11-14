//! Queries share their caller's snapshot. Unindexed reads scan storage IDs,
//! filter in Rust, and retain the application order: creation time, then ID.
use super::{Document, Error, Id, Order, Result, SurrealValue, Table, Transaction, Value, types::check_field};
use surrealdb_idx::val::Value as StoredValue;

pub struct Query<'tx> {
    tx: &'tx mut Transaction,
    table: Table,
    conditions: Vec<(String, Value)>,
    order: Order,
    limit: Option<u32>,
}

impl<'tx> Query<'tx> {
    pub(super) fn new(tx: &'tx mut Transaction, table: Table) -> Self {
        Self { tx, table, conditions: Vec::new(), order: Order::Asc, limit: None }
    }

    pub fn eq(mut self, field: impl Into<String>, value: impl SurrealValue) -> Self {
        self.conditions.push((field.into(), value.into_value()));
        self
    }

    pub fn order(mut self, order: Order) -> Self { self.order = order; self }
    pub fn limit(mut self, limit: u32) -> Self { self.limit = Some(limit); self }
    pub async fn take(self, limit: u32) -> Result<Vec<Document>> { self.limit(limit).collect().await }
    pub async fn first(self) -> Result<Option<Document>> {
        let limit = self.limit.unwrap_or(1).min(1);
        Ok(self.limit(limit).collect().await?.into_iter().next())
    }

    pub async fn collect(self) -> Result<Vec<Document>> {
        let result = async {
            self.tx.ready(false)?;
            for (field, value) in &self.conditions {
                check_field(field)?;
                if field == "_id" {
                    let Value::String(text) = value else {
                        return Err(Error::Invalid("_id equality requires a table:key string"));
                    };
                    text.parse::<Id>()?;
                }
            }
            // Validation and poisoning still apply to an explicitly empty query.
            if self.limit == Some(0) { return Ok(Vec::new()); }
            let mut rows = self.tx.scan_table(&self.table).await?;
            rows.retain(|row| self.conditions.iter().all(|(field, expected)| {
                StoredValue::from(field_value(row, field)) == StoredValue::from(expected.clone())
            }));
            rows.sort_by(|a, b| (a.creation_time, a.id.key()).cmp(&(b.creation_time, b.id.key())));
            if matches!(self.order, Order::Desc) { rows.reverse(); }
            if let Some(limit) = self.limit { rows.truncate(limit as usize); }
            Ok(rows)
        }.await;
        self.tx.finish(result)
    }
}

pub(super) fn field_value(row: &Document, field: &str) -> Value {
    match field {
        "_id" => Value::String(row.id.to_string()),
        "_creationTime" => Value::from_int(row.creation_time),
        field => row.fields.get(field).cloned().unwrap_or(Value::None),
    }
}
