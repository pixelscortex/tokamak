//! Queries share their caller's snapshot. Unindexed reads scan storage IDs,
//! filter in Rust, and retain the application order: creation time, then ID.
use super::{
    Document, Error, Id, Order, Result, SurrealValue, Table, Transaction, Value,
    types::{check_field, normalize},
};
use surrealdb_idx::{
    catalog::providers::TableProvider,
    expr::{BinaryOperator, Part},
    kernels::btree::IndexKeyspace,
    val::{TableName, Value as StoredValue},
};

pub struct Query<'tx> {
    tx: &'tx mut Transaction,
    table: Table,
    conditions: Vec<(String, Value)>,
    order: Order,
    limit: Option<u32>,
    index: Option<String>,
    bounds: Vec<(String, BinaryOperator, Value)>,
}

impl<'tx> Query<'tx> {
    pub(super) fn new(tx: &'tx mut Transaction, table: Table) -> Self {
        Self {
            tx,
            table,
            conditions: Vec::new(),
            order: Order::Asc,
            limit: None,
            index: None,
            bounds: Vec::new(),
        }
    }

    /// Match strict value equality on JSON-like values, with the same semantics
    /// for indexed and unindexed reads. NONE represents a missing value.
    /// Non-JSON-like operands (including nested values) return Error::Invalid
    /// and poison the transaction when the query executes, even with limit(0).
    pub fn eq(mut self, field: impl Into<String>, value: impl SurrealValue) -> Self {
        self.conditions.push((field.into(), value.into_value()));
        self
    }

    /// Read in the named index's field order, with ID breaking equal-key ties.
    /// Chain eq on leading fields, then gt/gte and/or lt/lte on the next field.
    /// Invalid bounds and unknown indexes poison the transaction at execution.
    pub fn with_index(mut self, name: &str) -> Self {
        self.index = Some(name.into());
        self
    }

    /// Constrain the indexed field to values greater than this JSON-like operand.
    /// Non-JSON-like operands return Error::Invalid and poison the transaction
    /// at execution, including limit(0); NONE is the missing-value sentinel.
    pub fn gt(self, field: impl Into<String>, value: impl SurrealValue) -> Self {
        self.bound(field, BinaryOperator::MoreThan, value)
    }
    /// Constrain the indexed field to values greater than or equal to this JSON-like operand.
    /// Non-JSON-like operands return Error::Invalid and poison the transaction
    /// at execution, including limit(0); NONE is the missing-value sentinel.
    pub fn gte(self, field: impl Into<String>, value: impl SurrealValue) -> Self {
        self.bound(field, BinaryOperator::MoreThanEqual, value)
    }
    /// Constrain the indexed field to values less than this JSON-like operand.
    /// Non-JSON-like operands return Error::Invalid and poison the transaction
    /// at execution, including limit(0); NONE is the missing-value sentinel.
    pub fn lt(self, field: impl Into<String>, value: impl SurrealValue) -> Self {
        self.bound(field, BinaryOperator::LessThan, value)
    }
    /// Constrain the indexed field to values less than or equal to this JSON-like operand.
    /// Non-JSON-like operands return Error::Invalid and poison the transaction
    /// at execution, including limit(0); NONE is the missing-value sentinel.
    pub fn lte(self, field: impl Into<String>, value: impl SurrealValue) -> Self {
        self.bound(field, BinaryOperator::LessThanEqual, value)
    }
    fn bound(
        mut self,
        field: impl Into<String>,
        operator: BinaryOperator,
        value: impl SurrealValue,
    ) -> Self {
        self.bounds
            .push((field.into(), operator, value.into_value()));
        self
    }

    pub fn order(mut self, order: Order) -> Self {
        self.order = order;
        self
    }
    pub fn limit(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }
    pub async fn take(self, limit: u32) -> Result<Vec<Document>> {
        self.limit(limit).collect().await
    }
    pub async fn first(self) -> Result<Option<Document>> {
        let limit = self.limit.unwrap_or(1).min(1);
        Ok(self.limit(limit).collect().await?.into_iter().next())
    }

    pub async fn collect(mut self) -> Result<Vec<Document>> {
        let result = async {
            self.tx.ready(false)?;
            // Validate every operand before choosing an access path or taking
            // an empty-query exit, and replace it with its canonical form: the
            // same normalization documents get before they are stored. Without
            // that, a hand-built narrow number (an i32 or f32 variant) would be
            // rejected or would fail to equal the stored canonical value.
            for value in self
                .conditions
                .iter_mut()
                .map(|(_, value)| value)
                .chain(self.bounds.iter_mut().map(|(_, _, value)| value))
            {
                *value = normalize(value.clone(), 0).map_err(|error| match error {
                    Error::Invalid(_) => Error::Invalid("query operands must be JSON-like"),
                    error => error,
                })?;
            }
            for (field, value) in &self.conditions {
                check_field(field)?;
                if field == "_id" {
                    let Value::String(text) = value else {
                        return Err(Error::Invalid("_id equality requires a table:key string"));
                    };
                    text.parse::<Id>()?;
                }
            }
            if let Some(name) = &self.index {
                return self.indexed(name).await;
            }
            if !self.bounds.is_empty() {
                return Err(Error::Invalid("range bounds require with_index"));
            }
            // Validation and poisoning still apply to an explicitly empty query.
            if self.limit == Some(0) {
                return Ok(Vec::new());
            }
            let mut rows = self.tx.scan_table(&self.table).await?;
            rows.retain(|row| {
                self.conditions.iter().all(|(field, expected)| {
                    StoredValue::from(field_value(row, field))
                        == StoredValue::from(expected.clone())
                })
            });
            rows.sort_by(|a, b| (a.creation_time, a.id.key()).cmp(&(b.creation_time, b.id.key())));
            if matches!(self.order, Order::Desc) {
                rows.reverse();
            }
            if let Some(limit) = self.limit {
                rows.truncate(limit as usize);
            }
            Ok(rows)
        }
        .await;
        self.tx.finish(result)
    }
    async fn indexed(&self, name: &str) -> Result<Vec<Document>> {
        let core = &self.tx.state.storage;
        let table = TableName::from(self.table.as_str());
        let index = self
            .tx
            .inner
            .get_tb_index(core.ns, core.db, &table, name, None)
            .await?
            .ok_or(Error::Invalid("the requested index does not exist"))?;
        let fields = index
            .cols
            .iter()
            .map(|column| {
                let [Part::Field(field), Part::Flatten] = column.0.as_slice() else {
                    return Err(Error::Invalid("index is not a TokamakDB value index"));
                };
                Ok(field.as_str())
            })
            .collect::<Result<Vec<_>>>()?;
        let mut prefix = Vec::new();
        for (position, (field, value)) in self.conditions.iter().enumerate() {
            if fields.get(position).copied() != Some(field.as_str()) {
                return Err(Error::Invalid(
                    "index equalities must follow its leading field order",
                ));
            }
            prefix.push(StoredValue::from(value.clone()));
        }
        let mut lower = None;
        let mut upper = None;
        for (field, operator, value) in &self.bounds {
            check_field(field)?;
            if fields.get(prefix.len()).copied() != Some(field.as_str()) {
                return Err(Error::Invalid(
                    "index range must constrain the field after the equality prefix",
                ));
            }
            let slot = match operator {
                BinaryOperator::MoreThan | BinaryOperator::MoreThanEqual => &mut lower,
                _ => &mut upper,
            };
            if slot.is_some() {
                return Err(Error::Invalid(
                    "an index range accepts one lower and one upper bound",
                ));
            }
            *slot = Some((operator, StoredValue::from(value.clone())));
        }
        // Contradictory ranges are empty; never hand an inverted byte range to
        // a backend. Validate all clauses and index existence before this exit.
        if let (Some((lo, lv)), Some((hi, hv))) = (&lower, &upper) {
            if lv > hv
                || (lv == hv
                    && (matches!(lo, BinaryOperator::MoreThan)
                        || matches!(hi, BinaryOperator::LessThan)))
            {
                return Ok(Vec::new());
            }
        }
        if self.limit == Some(0) {
            return Ok(Vec::new());
        }
        let range = IndexKeyspace::of(core.ns, core.db, &index).compound_between(
            &prefix,
            lower.as_ref().map(|(op, value)| (*op, value)),
            upper.as_ref().map(|(op, value)| (*op, value)),
        )?;
        let limit = self.limit.unwrap_or(u32::MAX);
        let entries = match self.order {
            Order::Asc => self.tx.inner.scan(range, limit, 0, None).await?,
            Order::Desc => self.tx.inner.scanr(range, limit, 0, None).await?,
        };
        let mut rows = Vec::with_capacity(entries.len());
        for (_, entry) in entries {
            let record = self
                .tx
                .inner
                .get_record(core.ns, core.db, &table, &entry.rid.key, None)
                .await?;
            rows.push(Document::decode(record.data.clone())?);
        }
        Ok(rows)
    }
}

pub(super) fn field_value(row: &Document, field: &str) -> Value {
    match field {
        "_id" => Value::String(row.id.to_string()),
        "_creationTime" => Value::from_int(row.creation_time),
        field => row.fields.get(field).cloned().unwrap_or(Value::None),
    }
}
