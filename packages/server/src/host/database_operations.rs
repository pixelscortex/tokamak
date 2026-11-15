use super::*;

pub(super) fn register(
    ops: &mut OpRegistry,
    shared: SharedTransaction,
    observations: Arc<Mutex<Observations>>,
    failure: Failure,
    space: DataSpace,
    writable: bool,
) {
    for operation in ["db.get", "db.query", "db.insert", "db.patch", "db.replace", "db.delete"] {
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
}

pub(super) fn field<'a>(payload: &'a Json, key: &str) -> data::Result<&'a Json> {
    payload
        .as_object()
        .and_then(|p| p.get(key))
        .ok_or(data::Error::Invalid("missing host operation field"))
}

pub(super) fn text<'a>(payload: &'a Json, key: &str) -> data::Result<&'a str> {
    field(payload, key)?
        .as_str()
        .ok_or(data::Error::Invalid("host operation field must be a string"))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexQuery {
    name: String,
    eq: Vec<IndexEquality>,
    range: Vec<IndexRange>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexEquality {
    field: String,
    value: Json,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexRange {
    field: String,
    operator: RangeOperator,
    value: Json,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum RangeOperator {
    Gt,
    Gte,
    Lt,
    Lte,
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
            let order = match text(&payload, "order")? {
                "asc" => Order::Asc,
                "desc" => Order::Desc,
                _ => return Err(data::Error::Invalid("order must be asc or desc")),
            };
            let limit = field(&payload, "limit")?;
            let limit = if limit.is_null() {
                usize::MAX
            } else {
                let count = limit.as_u64().filter(|n| *n <= 9_007_199_254_740_991).ok_or(
                    data::Error::Invalid("limit must be a nonnegative safe integer or null"),
                )?;
                usize::try_from(count).unwrap_or(usize::MAX)
            };
            if let Some(index) = payload.get("index") {
                if !clauses.is_empty() {
                    return Err(data::Error::Invalid(
                        "indexed queries require an empty where array",
                    ));
                }
                // Deserialize strictly before execution; the core validates index
                // existence, ordered leading equalities and the next-field range,
                // even for limit zero. It also poisons failed transactions.
                let index: IndexQuery = serde_json::from_value(index.clone()).map_err(|_| {
                    data::Error::Invalid(
                        "index must contain name, eq and range arrays with valid clauses",
                    )
                })?;
                // Range-aware dependencies can be added later. A whole-table read
                // correctly invalidates empty, bounded and limited index scans.
                reads.table(table.clone());
                let mut query = tx.query(&table).with_index(&index.name).order(order);
                for clause in index.eq {
                    query = query.eq(clause.field, clause.value);
                }
                for clause in index.range {
                    query = match clause.operator {
                        RangeOperator::Gt => query.gt(clause.field, clause.value),
                        RangeOperator::Gte => query.gte(clause.field, clause.value),
                        RangeOperator::Lt => query.lt(clause.field, clause.value),
                        RangeOperator::Lte => query.lte(clause.field, clause.value),
                    };
                }
                let rows =
                    Box::pin(query.limit(limit.min(u32::MAX as usize) as u32).collect()).await?;
                return Ok(Json::Array(
                    rows.into_iter()
                        .map(|doc| space.document(doc))
                        .collect::<data::Result<Vec<_>>>()?,
                ));
            }
            match record_dependency {
                Some(id) => reads.record(id),
                None => reads.filter(table.clone(), clauses.clone()),
            }
            let query = tx.query(&table).order(order);
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
                            doc.get(key).is_some_and(|actual| json_equal(actual, expected))
                        })
                    })
                    .take(limit)
                    .collect(),
            ))
        }
        "db.insert" => {
            let table = space.table(&Table::new(text(&payload, "table")?)?)?;
            let value = json_object(field(&payload, "value")?)?;
            Ok(json!(space.present_id(&Box::pin(tx.insert(&table, value)).await?)?))
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
