use super::{
    triggers::{Change, TriggerRegistry},
    *,
};
use crate::plugins::Loaded;

pub(super) fn register(
    ops: &mut OpRegistry,
    tx: &TransactionContext,
    context: &CallContext,
    space: DataSpace,
    writable: bool,
    graph: &Graph,
) {
    for name in [
        "db.get",
        "db.query",
        "db.insert",
        "db.patch",
        "db.replace",
        "db.delete",
    ] {
        let write = !matches!(name, "db.get" | "db.query");
        let op = DatabaseOperation {
            tx: tx.clone(),
            space: space.clone(),
            scope: context.scope.clone(),
            allowed: !write || writable,
            name,
        };

        if let Some((plugins, _)) = graph
            .as_ref()
            .filter(|(plugins, _)| writable && write && !plugins.triggers.is_empty())
        {
            let plugins = plugins.clone();
            let note = context.note.clone();
            ops.register_staged(name, move |executor, payload| {
                Box::pin(
                    op.clone()
                        .run_staged(executor, payload, plugins.clone(), note.clone()),
                )
            })
        } else {
            ops.register_async(name, move |payload| {
                let op = op.clone();
                Box::pin(async move {
                    let _scope = op.scope.clone().enter().await?;
                    op.apply(payload, None).await.map(|(value, _)| value)
                })
            })
        }
        .expect("fixed unique operation names");
    }
}

#[derive(Clone)]
struct DatabaseOperation {
    tx: TransactionContext,
    scope: CallScope,
    space: DataSpace,
    allowed: bool,
    name: &'static str,
}

impl DatabaseOperation {
    async fn run_staged(
        self,
        executor: &dyn engine::StageExecutor,
        payload: Json,
        plugins: Arc<Loaded>,
        note: CallNote,
    ) -> Result<Json, engine::CallError> {
        let _scope = self.scope.clone().enter().await?;
        let (value, changes) = self.apply(payload, Some(&plugins.triggers)).await?;
        for change in changes {
            change.run(executor, &plugins, &self.tx, &note).await?;
        }
        Ok(value)
    }

    async fn apply<'a>(
        &self,
        payload: Json,
        triggers: Option<&'a TriggerRegistry>,
    ) -> Result<(Json, Vec<Change<'a>>), String> {
        let mut guard = self.tx.shared.lock().await;
        let tx = guard.as_mut().ok_or("invocation transaction is finished")?;
        let observed = self.tx.observations.lock().await;

        if observed.error.is_some() || self.tx.failure.lock().expect("failure lock").is_some() {
            return Err("an earlier host operation failed".into());
        }

        let mut lease = Operation {
            observed,
            completed: false,
        };
        let mut changes = Vec::new();
        let result = if self.allowed {
            Box::pin(operation_call(
                tx,
                &mut *self.tx.reads.lock().await,
                &self.space,
                self.name,
                payload,
                triggers,
                &mut changes,
            ))
            .await
        } else {
            Err(data::Error::AccessDenied)
        };
        lease.completed = true;

        match result {
            Ok(value) => Ok((value, changes)),
            Err(error) => {
                lease.observed.conflict |= error.is_retryable_conflict();
                let message = error.to_string();
                lease.observed.error = Some(message.clone());
                Err(message)
            }
        }
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

async fn operation_call<'a>(
    tx: &mut Transaction,
    reads: &mut ReadSet,
    space: &DataSpace,
    op: &str,
    payload: Json,
    triggers: Option<&'a TriggerRegistry>,
    changes: &mut Vec<Change<'a>>,
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

            let row = Box::pin(tx.insert_document(&table, value)).await?;
            let id = space.present_id(&row.id)?;
            if let Some(watched) = triggers.and_then(|registry| registry.get(&table)) {
                changes.push(Change::record(watched, None, Some(row))?);
            }
            Ok(json!(id))
        }
        "db.delete" => {
            let id = space.id(text(&payload, "id")?)?;
            let Some(registry) = triggers else {
                Box::pin(tx.delete(&id)).await?;
                return Ok(Json::Null);
            };
            for row in Box::pin(tx.delete_documents(&id)).await? {
                if let Some(watched) = registry.get(row.id.table()) {
                    changes.push(Change::record(watched, Some(row), None)?);
                }
            }
            Ok(Json::Null)
        }
        "db.patch" | "db.replace" => {
            let id = space.id(text(&payload, "id")?)?;
            let value = json_object(field(&payload, "value")?)?;
            let updated = Box::pin(tx.update(&id, value, op == "db.replace")).await?;
            if let Some((old, new)) = updated
                && let Some(watched) = triggers.and_then(|registry| registry.get(id.table()))
            {
                changes.push(Change::record(watched, Some(old), Some(new))?);
            }
            Ok(Json::Null)
        }
        _ => unreachable!("registry contains only SDK operations"),
    }
}
