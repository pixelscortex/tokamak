//! Conservative query dependencies and bounded post-commit record footprints.
use super::{ChangeEvent, Document, Id, Table};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordChange {
    pub id: Id,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

/// JSON numbers have one language-level type, unlike serde's integer/float split.
pub fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| json_equal(a, b)))
        }
        _ => a == b,
    }
}

pub(crate) fn encoded_size(value: &impl serde::Serialize, maximum: usize) -> Option<usize> {
    struct Count {
        used: usize,
        maximum: usize,
    }
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.maximum.saturating_sub(self.used) {
                return Err(std::io::ErrorKind::OutOfMemory.into());
            }
            self.used += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count { used: 0, maximum };
    serde_json::to_writer(&mut count, value).ok()?;
    Some(count.used)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Dependency {
    Table(Table),
    Record(Id),
    Filter(Table, Vec<(String, Value)>),
}
impl Dependency {
    fn table(&self) -> &Table {
        match self {
            Self::Table(table) | Self::Filter(table, _) => table,
            Self::Record(id) => id.table(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReadSet {
    entries: Vec<Dependency>,
    bytes: usize,
    coarse: bool,
}
impl ReadSet {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn table(&mut self, table: Table) {
        self.observe(Dependency::Table(table), 0);
    }
    pub fn record(&mut self, id: Id) {
        self.observe(Dependency::Record(id), 0);
    }
    pub fn filter(&mut self, table: Table, clauses: Vec<(String, Value)>) {
        if clauses.is_empty() {
            self.table(table);
            return;
        }
        match encoded_size(&clauses, 8192) {
            Some(bytes) => self.observe(Dependency::Filter(table, clauses), bytes),
            None => self.table(table),
        }
    }
    fn observe(&mut self, mut dependency: Dependency, bytes: usize) {
        if self.coarse {
            dependency = Dependency::Table(dependency.table().clone());
        }
        if self.entries.iter().any(|entry| {
            matches!(entry, Dependency::Table(table) if table == dependency.table())
                || entry == &dependency
        }) {
            return;
        }
        if !self.coarse && (self.entries.len() >= 256 || self.bytes.saturating_add(bytes) > 65536) {
            let mut tables = std::collections::BTreeSet::new();
            for entry in &self.entries {
                tables.insert(entry.table().clone());
            }
            tables.insert(dependency.table().clone());
            self.entries = tables.into_iter().map(Dependency::Table).collect();
            self.coarse = true;
            self.bytes = 0;
            return;
        }
        if !self.coarse {
            self.bytes += bytes;
        }
        self.entries.push(dependency);
    }
    pub fn affected(&self, change: &ChangeEvent) -> bool {
        self.entries.iter().any(|dependency| {
            if !change.tables.contains(dependency.table()) {
                return false;
            }
            let Some(records) = &change.records else {
                return true;
            };
            match dependency {
                Dependency::Table(_) => true,
                Dependency::Record(id) => records.iter().any(|change| &change.id == id),
                Dependency::Filter(table, clauses) => records.iter().any(|change| {
                    change.id.table() == table
                        && [change.before.as_ref(), change.after.as_ref()]
                            .into_iter()
                            .flatten()
                            .any(|image| {
                                clauses.iter().all(|(key, value)| {
                                    image
                                        .get(key)
                                        .is_some_and(|actual| json_equal(actual, value))
                                })
                            })
                }),
            }
        })
    }
}

impl Document {
    /// Storage's wire snapshot is used by both the host and dependency matcher.
    pub fn into_json(self) -> Value {
        let mut value = super::Value::Object(self.fields).into_json_value();
        let fields = value
            .as_object_mut()
            .expect("native object converts to JSON object");
        fields.insert("_id".into(), Value::String(self.id.to_string()));
        fields.insert("_creationTime".into(), Value::from(self.creation_time));
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(before: Option<Value>, after: Option<Value>) -> ChangeEvent {
        ChangeEvent {
            tables: vec![Table::new("items").unwrap()],
            records: Some(vec![RecordChange {
                id: "items:missing".parse().unwrap(),
                before,
                after,
            }]),
        }
    }
    #[test]
    fn empty_record_reads_and_json_numeric_filter_equality_remain_sound() {
        let mut reads = ReadSet::new();
        reads.record("items:missing".parse().unwrap());
        assert!(reads.affected(&change(None, Some(json!({"_id":"items:missing"})))));
        let mut reads = ReadSet::new();
        reads.filter(
            Table::new("items").unwrap(),
            vec![("key".into(), json!({"n":[1.0]}))],
        );
        assert!(reads.affected(&change(None, Some(json!({"key":{"n":[1]}})))));
        assert!(!reads.affected(&change(None, Some(json!({"other":null})))));
        let mut null = ReadSet::new();
        null.filter(
            Table::new("items").unwrap(),
            vec![("key".into(), Value::Null)],
        );
        assert!(!null.affected(&change(None, Some(json!({})))));
        assert!(null.affected(&change(None, Some(json!({"key":null})))));
    }
    #[test]
    fn tracking_and_notification_budgets_degrade_to_tables_not_missed_updates() {
        let table = Table::new("items").unwrap();
        let mut reads = ReadSet::new();
        for key in 0..300 {
            reads.filter(table.clone(), vec![("key".into(), json!(key))]);
        }
        assert!(reads.affected(&change(None, Some(json!({"key":"outside filters"})))));
        let mut reads = ReadSet::new();
        reads.filter(table.clone(), vec![("key".into(), json!("x".repeat(9000)))]);
        assert!(reads.affected(&change(None, Some(json!({})))));
        let mut reads = ReadSet::new();
        reads.filter(table.clone(), vec![("key".into(), json!("A"))]);
        assert!(reads.affected(&ChangeEvent {
            tables: vec![table],
            records: None
        }));
    }
}
