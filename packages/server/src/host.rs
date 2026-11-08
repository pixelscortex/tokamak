//! One invocation's SDK capabilities. No SQL, client, or ambient call identity
//! reaches JavaScript. Futures are boxed at the database boundary to keep the
//! embedded engine's large debug futures off the QuickJS worker's native stack.

use crate::data::{self, DataSpace, Order, Table, Transaction, json_equal, json_object};
use engine::{Bundle, ModuleCall, OpRegistry, Pool};
use serde_json::{Value as Json, json};
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) use crate::data::ReadSet;

type SharedTransaction = Arc<Mutex<Option<Transaction>>>;
type Failure = Arc<std::sync::Mutex<Option<String>>>;

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
    bundle: Option<Arc<Bundle>>,
    name: &str,
    args: Json,
    mutation: bool,
    space: &DataSpace,
    plugins: Option<Arc<crate::plugins::Loaded>>,
) -> Call {
    let (bundle, name, space, graph) = if let Some(plugins) = plugins {
        let target = plugins
            .targets
            .get(name)
            .expect("coordinator validated target")
            .clone();
        (
            target.bundle,
            target.local_name,
            target.space,
            Some((plugins, target.owner, vec![name.to_owned()])),
        )
    } else {
        (
            bundle.expect("legacy bundle"),
            name.to_owned(),
            space.clone(),
            None,
        )
    };
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
    let failure: Failure = Arc::default();
    let ops = operations(
        shared.clone(),
        observations.clone(),
        failure.clone(),
        space,
        mutation,
        graph,
    );
    let result = match pool.submit(bundle, "invoke", json!({"name":name,"args":args}), ops) {
        Ok(pending) => pending.await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let tx = shared
        .lock()
        .await
        .take()
        .expect("only invocation owner finishes");
    let mut observed = observations.lock().await;
    let result = result.and_then(|value| {
        let nested = failure.lock().expect("failure lock");
        match observed.error.as_ref().or(nested.as_ref()) {
            Some(error) => Err(error.clone()),
            None => Ok(value),
        }
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

type Graph = Option<(Arc<crate::plugins::Loaded>, String, Vec<String>)>;

fn operations(
    shared: SharedTransaction,
    observations: Arc<Mutex<Observations>>,
    failure: Failure,
    space: DataSpace,
    writable: bool,
    graph: Graph,
) -> Arc<OpRegistry> {
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
        let space = space.clone();
        let failure = failure.clone();
        ops.register_async(operation, move |payload| {
            let shared = shared.clone();
            let observations = observations.clone();
            let space = space.clone();
            let failure = failure.clone();
            // This future is polled directly, never detached on another executor.
            // Runtime retirement drops it before replying; taking the Option below
            // revokes even retained callbacks before commit/rollback can start.
            Box::pin(async move {
                let mut guard = shared.lock().await;
                let tx = guard.as_mut().ok_or("invocation transaction is finished")?;
                let observed = observations.lock().await;
                if observed.error.is_some() || failure.lock().expect("failure lock").is_some() {
                    return Err("an earlier host operation failed".into());
                }
                let mut lease = Operation {
                    observed,
                    completed: false,
                };
                let result = if !writable && !["db.get", "db.query"].contains(&operation) {
                    Err(data::Error::AccessDenied)
                } else {
                    Box::pin(operation_call(
                        tx,
                        &mut lease.observed.reads,
                        &space,
                        operation,
                        payload,
                    ))
                    .await
                };
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
    if let Some((plugins, owner, path)) = graph {
        let catalog = plugins.clone();
        let caller = owner.clone();
        let failed = failure.clone();
        ops.register_sync("plugin.providers", move |payload| {
            let result = text(&payload, "interface")
                .map_err(|e| e.to_string())
                .and_then(|interface| {
                    catalog
                        .catalog
                        .providers(&caller, interface)
                        .map_err(|e| e.to_string())
                })
                .map(|ids| json!(ids));
            if let Err(error) = &result {
                *failed.lock().expect("failure lock") = Some(error.clone());
            }
            result
        })
        .expect("unique operation");
        ops.register_module("plugin.call", move |payload| {
            let resolved = (|| {
                if failure.lock().expect("failure lock").is_some() {
                    return Err("An earlier plugin operation failed".to_string());
                }
                let name = text(&payload, "name").map_err(|e| e.to_string())?;
                let args = field(&payload, "args").map_err(|e| e.to_string())?.clone();
                let target = plugins.target(&owner, name, writable, &path)?;
                let mut child_path = path.clone();
                child_path.push(name.into());
                let child_ops = operations(
                    shared.clone(),
                    observations.clone(),
                    failure.clone(),
                    target.space,
                    target.mutation,
                    Some((plugins.clone(), target.owner, child_path)),
                );
                let failed = failure.clone();
                Ok(ModuleCall::new(
                    target.bundle,
                    "invoke",
                    json!({"name":target.local_name,"args":args}),
                    child_ops,
                    move |error| {
                        *failed.lock().expect("failure lock") = Some(error);
                    },
                ))
            })();
            if let Err(error) = &resolved {
                *failure.lock().expect("failure lock") = Some(error.clone());
            }
            resolved
        })
        .expect("unique operation");
    }
    Arc::new(ops)
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

async fn operation_call(
    tx: &mut Transaction,
    reads: &mut ReadSet,
    space: &DataSpace,
    op: &str,
    payload: Json,
) -> data::Result<Json> {
    match op {
        "db.get" => {
            let id = space.id(text(&payload, "id")?)?;
            reads.record(id.clone()); // Missing records are dependencies too.
            Box::pin(tx.get(&id))
                .await?
                .map(|doc| space.document(doc))
                .transpose()
                .map(|doc| doc.unwrap_or(Json::Null))
        }
        "db.query" => {
            let table = space.table(&Table::new(text(&payload, "table")?)?)?;
            let mut clauses = Vec::new();
            let mut record_dependency = None;
            for clause in field(&payload, "where")?
                .as_array()
                .ok_or(data::Error::Invalid("where must be an array"))?
            {
                let name = text(clause, "field")?.to_owned();
                if name.is_empty() {
                    return Err(data::Error::Invalid("filter field must be nonempty"));
                }
                let mut value = field(clause, "value")?.clone();
                if name == "_id" {
                    if let Some(raw) = value.as_str() {
                        match space.id(raw) {
                            Ok(id) => {
                                value = space.present_id(&id)?.into();
                                record_dependency = Some(id);
                            }
                            Err(data::Error::AccessDenied) => {
                                return Err(data::Error::AccessDenied);
                            }
                            Err(_) => {} // Invalid ID equality is an empty read, not a SQL expression.
                        }
                    }
                }
                clauses.push((name, value));
            }
            match record_dependency {
                Some(id) => reads.record(id),
                None => reads.filter(table.clone(), clauses.clone()),
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
            let rows = rows
                .into_iter()
                .map(|doc| space.document(doc))
                .collect::<data::Result<Vec<_>>>()?;
            Ok(Json::Array(
                rows.into_iter()
                    .filter(|doc| {
                        clauses.iter().all(|(key, expected)| {
                            doc.get(key)
                                .is_some_and(|actual| json_equal(actual, expected))
                        })
                    })
                    .take(limit)
                    .collect(),
            ))
        }
        "db.insert" => {
            let table = space.table(&Table::new(text(&payload, "table")?)?)?;
            let value = json_object(field(&payload, "value")?)?;
            Ok(json!(
                space.present_id(&Box::pin(tx.insert(&table, value)).await?)?
            ))
        }
        "db.patch" | "db.replace" | "db.delete" => {
            let id = space.id(text(&payload, "id")?)?;
            if op == "db.delete" {
                Box::pin(tx.delete(&id)).await?;
            } else {
                let value = json_object(field(&payload, "value")?)?;
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
