//! One invocation's SDK capabilities. No SQL, client, or ambient call identity
//! reaches JavaScript. Futures are boxed at the database boundary to keep the
//! embedded engine's large debug futures off the QuickJS worker's native stack.

use crate::data::{self, Document, Id, Object, Order, SurrealValue, Table, Transaction, Value};
use runtime::{Bundle, OpRegistry, Pool};
use serde_json::{Value as Json, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::Mutex;

pub(crate) type ReadSet = BTreeSet<Table>;

type SharedTransaction = Arc<Mutex<Option<Transaction>>>;

#[derive(Default)]
struct Observations {
    reads: ReadSet,
    // Boundary errors must poison the call even when feature code catches them.
    error: Option<String>,
    conflict: bool,
}

// Dropping a pending SDK request does not retract a statement already sent to
// its transaction actor. If JS returns without awaiting it, poison the WHOLE
// invocation; otherwise COMMIT could save a write whose footprint was never
// recorded. Rollback is queued after those statements on the same transaction.
struct Operation<'a> {
    observed: tokio::sync::MutexGuard<'a, Observations>,
    completed: bool,
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.observed.error = Some("host operation abandoned before completion".into());
            self.observed.conflict = false;
        }
    }
}

pub(crate) struct Call {
    pub result: Result<Json, String>,
    pub reads: ReadSet,
    pub conflict: bool,
}

pub(crate) async fn invoke(
    db: &data::Database,
    pool: &Pool,
    bundle: Arc<Bundle>,
    name: &str,
    args: Json,
    mutation: bool,
) -> Call {
    let tx = if mutation {
        Box::pin(db.begin()).await
    } else {
        Box::pin(db.read_only()).await
    };
    let tx = match tx {
        Ok(tx) => tx,
        Err(e) => {
            return Call {
                conflict: e.is_retryable_conflict(),
                result: Err(e.to_string()),
                reads: ReadSet::new(),
            };
        }
    };
    let shared: SharedTransaction = Arc::new(Mutex::new(Some(tx)));
    let observations = Arc::new(Mutex::new(Observations::default()));
    let mut ops = OpRegistry::new();
    for operation in [
        "db.get",
        "db.query",
        "db.insert",
        "db.patch",
        "db.replace",
        "db.delete",
    ] {
        let shared = shared.clone();
        let observations = observations.clone();
        ops.register_async(operation, move |payload| {
            let shared = shared.clone();
            let observations = observations.clone();
            // This future is polled directly, never detached on another executor.
            // Runtime retirement drops it before replying; taking the Option below
            // revokes even retained callbacks before commit/rollback can start.
            Box::pin(async move {
                let mut guard = shared.lock().await;
                let tx = guard.as_mut().ok_or("invocation transaction is finished")?;
                let observed = observations.lock().await;
                if observed.error.is_some() {
                    return Err("an earlier host operation failed".into());
                }
                let mut lease = Operation {
                    observed,
                    completed: false,
                };
                let result = Box::pin(operation_call(
                    tx,
                    &mut lease.observed.reads,
                    operation,
                    payload,
                ))
                .await;
                lease.completed = true;
                match result {
                    Ok(value) => Ok(value),
                    Err(error) => {
                        lease.observed.conflict |= error.is_retryable_conflict();
                        let message = error.to_string();
                        lease.observed.error = Some(message.clone());
                        Err(message)
                    }
                }
            })
        })
        .expect("fixed unique operation names");
    }
    let result = match pool.submit(
        bundle,
        "invoke",
        json!({"name":name,"args":args}),
        Arc::new(ops),
    ) {
        Ok(pending) => pending.await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let tx = shared
        .lock()
        .await
        .take()
        .expect("only invocation owner finishes");
    let mut observed = observations.lock().await;
    let result = result.and_then(|value| match &observed.error {
        Some(error) => Err(error.clone()),
        None => Ok(value),
    });
    let result = match result {
        Ok(value) => match Box::pin(tx.commit()).await {
            Ok(()) => Ok(value),
            Err(error) => {
                observed.conflict |= error.is_retryable_conflict();
                Err(format!(
                    "transaction commit failed (outcome may be unknown): {error}"
                ))
            }
        },
        Err(error) => match Box::pin(tx.rollback()).await {
            Ok(()) => Err(error),
            Err(rollback) => {
                // A failed rollback is not evidence that replay is safe.
                observed.conflict = false;
                Err(format!("{error}; rollback failed: {rollback}"))
            }
        },
    };
    Call {
        result,
        reads: std::mem::take(&mut observed.reads),
        conflict: observed.conflict,
    }
}

fn field<'a>(payload: &'a Json, key: &str) -> data::Result<&'a Json> {
    payload
        .as_object()
        .and_then(|p| p.get(key))
        .ok_or(data::Error::Invalid("missing host operation field"))
}

fn text<'a>(payload: &'a Json, key: &str) -> data::Result<&'a str> {
    field(payload, key)?.as_str().ok_or(data::Error::Invalid(
        "host operation field must be a string",
    ))
}

fn object(value: &Json) -> data::Result<Object> {
    match value.clone().into_value() {
        Value::Object(object) => Ok(object),
        _ => Err(data::Error::Invalid("document must be a JSON object")),
    }
}

fn document(doc: Document) -> Json {
    let mut value = Value::Object(doc.fields).into_json_value();
    let fields = value
        .as_object_mut()
        .expect("native object converts to JSON object");
    fields.insert("_id".into(), json!(doc.id.to_string()));
    fields.insert("_creationTime".into(), json!(doc.creation_time));
    value
}

// JavaScript has one numeric type: serde_json distinguishes 1 and 1.0, while
// SDK structural equality must not. The subscription results themselves have
// already crossed JSON.stringify in QuickJS and can use ordinary Value equality.
fn json_equal(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(a), Json::Number(b)) => a.as_f64() == b.as_f64(),
        (Json::Array(a), Json::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Json::Object(a), Json::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| json_equal(a, b)))
        }
        _ => a == b,
    }
}

async fn operation_call(
    tx: &mut Transaction,
    reads: &mut ReadSet,
    op: &str,
    payload: Json,
) -> data::Result<Json> {
    match op {
        "db.get" => {
            let id: Id = text(&payload, "id")?.parse()?;
            reads.insert(id.table().clone()); // Missing records are dependencies too.
            Ok(Box::pin(tx.get(&id))
                .await?
                .map(document)
                .unwrap_or(Json::Null))
        }
        "db.query" => {
            let table = Table::new(text(&payload, "table")?)?;
            reads.insert(table.clone()); // Includes empty results and limit zero.
            let mut clauses = Vec::new();
            for clause in field(&payload, "where")?
                .as_array()
                .ok_or(data::Error::Invalid("where must be an array"))?
            {
                let name = text(clause, "field")?;
                if name.is_empty() {
                    return Err(data::Error::Invalid("filter field must be nonempty"));
                }
                clauses.push((name, field(clause, "value")?));
            }
            let query = tx.query(&table).order(match text(&payload, "order")? {
                "asc" => Order::Asc,
                "desc" => Order::Desc,
                _ => return Err(data::Error::Invalid("order must be asc or desc")),
            });
            let limit = field(&payload, "limit")?;
            let limit = if limit.is_null() {
                usize::MAX
            } else {
                let count = limit
                    .as_u64()
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(data::Error::Invalid(
                        "limit must be a nonnegative safe integer or null",
                    ))?;
                usize::try_from(count).unwrap_or(usize::MAX)
            };
            // SDK fields are arbitrary TOP-LEVEL JSON keys, not SQL paths. Native
            // query equality has a narrower identifier/value language. Scan the
            // same snapshot in storage order, then apply SDK JSON equality and
            // limit here, rather than interpreting dotted keys or SQL NONE/null.
            let rows = Box::pin(query.collect()).await?;
            Ok(Json::Array(
                rows.into_iter()
                    .map(document)
                    .filter(|doc| {
                        clauses.iter().all(|(key, expected)| {
                            doc.get(*key)
                                .is_some_and(|actual| json_equal(actual, expected))
                        })
                    })
                    .take(limit)
                    .collect(),
            ))
        }
        "db.insert" => {
            let table = Table::new(text(&payload, "table")?)?;
            let value = object(field(&payload, "value")?)?;
            Ok(json!(Box::pin(tx.insert(&table, value)).await?.to_string()))
        }
        "db.patch" | "db.replace" | "db.delete" => {
            let id: Id = text(&payload, "id")?.parse()?;
            if op == "db.delete" {
                Box::pin(tx.delete(&id)).await?;
            } else {
                let value = object(field(&payload, "value")?)?;
                if op == "db.patch" {
                    Box::pin(tx.patch(&id, value)).await?;
                } else {
                    Box::pin(tx.replace(&id, value)).await?;
                }
            }
            Ok(Json::Null)
        }
        _ => unreachable!("registry contains only SDK operations"),
    }
}
