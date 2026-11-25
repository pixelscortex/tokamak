use super::{
    hooks::{StageCall, StageKind, execute_stage},
    *,
};
use crate::{
    data::Document,
    plugins::Loaded,
    protocol::{CallErrorDetails, StructuredCallError},
};
use engine::StageExecutor;
use std::collections::HashMap;

pub(crate) type TriggerRegistry = HashMap<Table, Arc<TableTriggers>>;

pub(crate) struct TableTriggers {
    pub name: String,
    pub space: DataSpace,
    pub handlers: Vec<Trigger>,
}

pub(crate) struct Trigger {
    pub owner: String,
    pub name: String,
}

impl TableTriggers {
    pub(crate) fn list(&self) -> Vec<Json> {
        self.handlers
            .iter()
            .map(|trigger| json!({"plugin": trigger.owner, "name": trigger.name}))
            .collect()
    }
}

pub(super) struct Change<'a> {
    table: &'a Arc<TableTriggers>,
    input: Json,
}

impl<'a> Change<'a> {
    pub(super) fn record(
        table: &'a Arc<TableTriggers>,
        old: Option<Document>,
        new: Option<Document>,
    ) -> data::Result<Self> {
        let operation = match (&old, &new) {
            (None, Some(_)) => "insert",
            (Some(_), Some(_)) => "update",
            (Some(_), None) => "delete",
            (None, None) => unreachable!("a change has at least one document"),
        };
        let old = old.map(|row| table.space.document(row)).transpose()?;
        let new = new.map(|row| table.space.document(row)).transpose()?;
        let id = &new.as_ref().or(old.as_ref()).expect("change document")["_id"];

        Ok(Self {
            table,
            input: json!({"operation": operation, "id": id, "oldDoc": old, "newDoc": new}),
        })
    }

    pub(super) async fn run(
        self,
        executor: &dyn StageExecutor,
        plugins: &Arc<Loaded>,
        tx: &TransactionContext,
        note: &CallNote,
    ) -> Result<(), engine::CallError> {
        if let Some(error) = tx.trigger_failed() {
            return Err(error);
        }

        for (index, trigger) in self.table.handlers.iter().enumerate() {
            let error = |kind, reason: &str| self.table.error(trigger, kind, reason);
            let table = self.table.clone();
            let label: TimeoutLabel = Arc::new(move || {
                table.error(
                    &table.handlers[index],
                    "triggerTimeout",
                    "trigger did not finish",
                )
            });
            let mut pending = PendingTrigger {
                tx,
                timeout: Some(label.clone()),
            };

            let result = match note.enter(&self.table.name, None, &Json::Null) {
                Ok(note) => {
                    let note = note.trigger_stage();
                    if note.take_hook_stage() {
                        execute_stage(
                            executor,
                            tx,
                            plugins,
                            StageCall {
                                owner: &trigger.owner,
                                kind: StageKind::Trigger,
                                note,
                                input: json!({"name": trigger.name, "change": self.input}),
                                label,
                            },
                        )
                        .await
                    } else {
                        Err(engine::CallError {
                            message: "delegated module count budget exceeded".into(),
                            details: None,
                            limit: Some(engine::CallLimit::Modules),
                        })
                    }
                }
                Err(error) => Err(engine::CallError {
                    message: error.to_string(),
                    details: None,
                    limit: Some(engine::CallLimit::Depth),
                }),
            };

            let result = tx.trigger_failed().map_or(result, Err).map_err(|cause| {
                if cause
                    .details
                    .as_ref()
                    .is_some_and(|details| details["stage"] == "trigger")
                {
                    cause
                } else {
                    let kind = match cause.limit {
                        Some(engine::CallLimit::Depth) => "triggerDepthLimit",
                        Some(engine::CallLimit::Modules) => "triggerBudgetLimit",
                        None => "triggerException",
                    };
                    error(
                        kind,
                        cause.message.split("\n    at ").next().unwrap_or_default(),
                    )
                }
            });
            pending.timeout = None;
            if let Err(error) = &result {
                pending.poison(|| error.clone());
            }
            result?;
        }
        Ok(())
    }
}

impl TableTriggers {
    fn error(&self, trigger: &Trigger, kind: &str, reason: &str) -> engine::CallError {
        let mut chain = self
            .handlers
            .iter()
            .take(10)
            .map(|entry| format!("{}/{}", entry.owner, entry.name))
            .collect::<Vec<_>>()
            .join(", ");
        if self.handlers.len() > 10 {
            use std::fmt::Write;
            let _ = write!(chain, ", {} more", self.handlers.len() - 10);
        }
        let table = &self.name;
        let message = format!(
            "Trigger {}/{} on {table}: {reason} (registered triggers: {chain})",
            trigger.owner, trigger.name
        );
        CallError::Structured(Box::new(StructuredCallError {
            message,
            details: CallErrorDetails {
                plugin: trigger.owner.clone(),
                hook: trigger.name.clone(),
                stage: "trigger".into(),
                kind: kind.into(),
                table: Some(table.clone()),
                data: json!(reason),
            },
        }))
        .into()
    }
}

// A suspended trigger can be dropped if its owner leaves a write unawaited.
struct PendingTrigger<'a> {
    tx: &'a TransactionContext,
    timeout: Option<TimeoutLabel>,
}

impl PendingTrigger<'_> {
    fn poison(&self, failure: impl FnOnce() -> engine::CallError) {
        self.tx
            .trigger_failure
            .lock()
            .expect("trigger failure lock")
            .get_or_insert_with(failure);
    }
}

impl Drop for PendingTrigger<'_> {
    fn drop(&mut self) {
        if let Some(timeout) = self.timeout.take() {
            self.poison(|| timeout());
        }
    }
}
