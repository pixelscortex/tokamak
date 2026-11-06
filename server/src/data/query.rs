//! A small equality-only query builder, not a SQL builder exposed to features.
//! Statement text varies only with the number of AND terms and a closed order
//! enum. Field names are validated single fields then bound via type::field;
//! values and limits never become SQL text. No indexes or pagination are implied.

use super::{
    Document, Error, Id, Object, Order, Result, Table, Transaction, Value, types::check_field,
};
use surrealdb::types::SurrealValue;

pub struct Query<'tx> {
    tx: &'tx mut Transaction,
    table: Table,
    conditions: Vec<(String, Value)>,
    order: Order,
    limit: Option<u32>,
}

impl<'tx> Query<'tx> {
    pub(super) fn new(tx: &'tx mut Transaction, table: Table) -> Self {
        Self {
            tx,
            table,
            conditions: Vec::new(),
            order: Order::Asc,
            limit: None,
        }
    }

    pub fn eq(mut self, field: impl Into<String>, value: impl SurrealValue) -> Self {
        self.conditions.push((field.into(), value.into_value()));
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
        // first() must not widen an explicitly empty query.
        let limit = self.limit.unwrap_or(1).min(1);
        Ok(self.limit(limit).collect().await?.into_iter().next())
    }

    pub async fn collect(self) -> Result<Vec<Document>> {
        let mut bindings = Object::new();
        bindings.insert("table", self.table.as_str());
        let prepared = (|| {
            let mut sql = String::from("SELECT * FROM type::table($table)");
            for (index, (field, value)) in self.conditions.into_iter().enumerate() {
                check_field(&field)?;
                let (field, value) = if field == "_id" {
                    let Value::String(text) = value else {
                        return Err(Error::Invalid("_id equality requires a table:key string"));
                    };
                    (
                        "id".to_owned(),
                        Value::RecordId(text.parse::<Id>()?.record()),
                    )
                } else {
                    // Only creation metadata is top-level; business fields,
                    // including `id`, live inside the private storage envelope.
                    let path = if field == "_creationTime" {
                        field
                    } else {
                        format!("data.{field}")
                    };
                    (path, value)
                };
                sql.push_str(if index == 0 { " WHERE " } else { " AND " });
                sql.push_str(&format!("type::field($f{index}) = $v{index}"));
                bindings.insert(format!("f{index}"), field);
                bindings.insert(format!("v{index}"), value);
            }
            // Storage `id` maps to `_id`. With one table and string keys its
            // order is the same, including when several inserts share a millisecond.
            sql.push_str(match self.order {
                Order::Asc => " ORDER BY _creationTime ASC, id ASC",
                Order::Desc => " ORDER BY _creationTime DESC, id DESC",
            });
            if let Some(limit) = self.limit {
                sql.push_str(" LIMIT $limit");
                bindings.insert("limit", i64::from(limit));
            }
            Ok(sql)
        })();
        let sql = self.tx.finish(prepared)?;
        // An explicitly empty query needs no storage scan, but it must still
        // validate its filters and reject a previously failed transaction.
        if self.limit == Some(0) {
            // A previously poisoned transaction must not silently succeed.
            let ready = self.tx.ready(false);
            self.tx.finish(ready)?;
            return Ok(Vec::new());
        }
        self.tx.rows(sql, bindings, false).await
    }
}
