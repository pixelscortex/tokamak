use super::*;

pub(super) fn register(
    ops: &mut OpRegistry,
    shared: SharedTransaction,
    observations: Arc<Mutex<Observations>>,
    failure: Failure,
    space: DataSpace,
    writable: bool,
) {
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
}

pub(super) fn field<'a>(payload: &'a Json, key: &str) -> data::Result<&'a Json> {
    payload
        .as_object()
        .and_then(|p| p.get(key))
        .ok_or(data::Error::Invalid("missing host operation field"))
}

pub(super) fn text<'a>(payload: &'a Json, key: &str) -> data::Result<&'a str> {
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
        "db.query" => super::database_queries::query(tx, reads, space, &payload).await,
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
