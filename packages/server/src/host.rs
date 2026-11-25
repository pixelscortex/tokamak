//! One invocation's SDK capabilities, including its explicit caller identity.
//! No SQL or client reaches JavaScript. Futures are boxed at the database boundary to keep the
//! embedded engine's large debug futures off the QuickJS runtime's native stack.

use crate::data::{self, DataSpace, Order, Table, Transaction, json_equal, json_object};
use crate::identity::CallNote;
use crate::protocol::{CallError, failure_kind};
use engine::{Bundle, Determinism, ModuleCall, OpRegistry, Pool};
use serde_json::{Value as Json, json};
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard};

pub(crate) use crate::data::ReadSet;

type SharedTransaction = Arc<Mutex<Option<Transaction>>>;
type Failure = Arc<std::sync::Mutex<Option<engine::CallError>>>;

#[derive(Clone)]
struct TransactionContext {
    shared: SharedTransaction,
    observations: Arc<Mutex<Observations>>,
    failure: Failure,
    trigger_failure: Failure,
    active_stages: Arc<std::sync::Mutex<Vec<Arc<engine::CallError>>>>,
    reads: Arc<Mutex<ReadSet>>,
}

impl TransactionContext {
    fn new(tx: Transaction) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Some(tx))),
            observations: Arc::default(),
            failure: Arc::default(),
            trigger_failure: Arc::default(),
            active_stages: Arc::default(),
            reads: Arc::default(),
        }
    }

    fn poison(&self, error: engine::CallError) {
        *self.failure.lock().expect("failure lock") = Some(error);
    }

    fn trigger_failed(&self) -> Option<engine::CallError> {
        self.trigger_failure
            .lock()
            .expect("trigger failure lock")
            .clone()
    }

    fn stage_scope(&self) -> Self {
        Self {
            observations: Arc::default(),
            failure: Arc::default(),
            ..self.clone()
        }
    }

    fn call_error(&self, error: engine::Error) -> CallError {
        if matches!(error, engine::Error::Timeout { phase: "call" })
            && let Some(stage) = self
                .active_stages
                .lock()
                .expect("active stages lock")
                .last()
        {
            return (**stage).clone().into();
        }
        engine::CallError::from(error).into()
    }
}

#[derive(Default)]
struct Observations {
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
    pub result: Result<Json, CallError>,
    pub reads: ReadSet,
    pub conflict: bool,
}

pub(crate) struct Invocation<'a> {
    pub bundle: Option<Arc<Bundle>>,
    pub name: &'a str,
    pub args: Json,
    pub mutation: bool,
    pub space: &'a DataSpace,
    pub plugins: Option<Arc<crate::plugins::Loaded>>,
    pub determinism: Determinism,
    pub note: CallNote,
}

pub(crate) async fn invoke(db: &data::Database, pool: &Pool, invocation: Invocation<'_>) -> Call {
    let Invocation {
        bundle,
        name,
        args,
        mutation,
        space,
        plugins,
        determinism,
        note,
    } = invocation;
    let note = match plugins.as_ref().and_then(|loaded| loaded.targets.get(name)) {
        Some(target) => note.with_root_args(&target.args, &args),
        None => note,
    };
    let target_name = name;
    let (bundle, name, space, graph) = resolve_invocation(bundle, name, space, plugins);
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
                result: Err(e.to_string().into()),
                reads: ReadSet::new(),
            };
        }
    };

    let context = TransactionContext::new(tx);

    let ops = operations(
        context.clone(),
        space,
        mutation,
        graph,
        CallContext {
            determinism: Some(determinism),
            note,
            scope: CallScope::default(),
            qualified: Some(target_name.to_owned()),
        },
    );
    let result = match pool.submit(bundle, "invoke", json!({"name":name,"args":args}), ops) {
        Ok(call) => call.await,
        Err(error) => Err(error),
    }
    .map_err(|error| context.call_error(error));

    let tx = context
        .shared
        .lock()
        .await
        .take()
        .expect("only invocation owner finishes");

    let mut observed = context.observations.lock().await;

    let result = if let Some(error) = context.trigger_failed() {
        Err(error.into())
    } else {
        result
    };
    let result = result.and_then(|value| {
        let nested = context.failure.lock().expect("failure lock");

        if let Some(error) = &observed.error {
            Err(error.clone().into())
        } else if let Some(error) = nested.as_ref() {
            Err(error.clone().into())
        } else {
            Ok(value)
        }
    });

    let result = finish_transaction(tx, result, mutation, &mut observed).await;
    Call {
        result,
        reads: std::mem::take(&mut *context.reads.lock().await),
        conflict: observed.conflict,
    }
}

type Graph = Option<(Arc<crate::plugins::Loaded>, String)>;

struct CallContext {
    determinism: Option<Determinism>,
    note: CallNote,
    scope: CallScope,
    qualified: Option<String>,
}

// A child holds its parent's gate, so siblings and parent DB operations cannot
// enter its savepoint. The child has its own gate for calls made inside it.
#[derive(Clone, Default)]
struct CallScope {
    closed: Arc<Mutex<bool>>,
}

impl CallScope {
    async fn enter(self) -> Result<OwnedMutexGuard<bool>, String> {
        let closed = self.closed.lock_owned().await;
        if *closed {
            return Err("plugin call has already returned".into());
        }
        Ok(closed)
    }

    async fn close(self) {
        *self.closed.lock().await = true;
    }

    fn nest(
        self,
        child: Self,
        shared: SharedTransaction,
        mutation: bool,
        call: ModuleCall,
    ) -> ModuleCall {
        let opening = shared.clone();
        call.with_scope(
            async move {
                let guard = self.enter().await?;
                let savepoint = if mutation {
                    let mut shared = opening.lock().await;
                    let tx = shared
                        .as_mut()
                        .ok_or("invocation transaction is finished")?;
                    Some(Box::pin(tx.savepoint()).await.map_err(|e| e.to_string())?)
                } else {
                    None
                };
                Ok((guard, savepoint))
            },
            move |(parent, savepoint), value| async move {
                let _parent = parent;
                // Settle this scope before other calls can enter the parent.
                child.close().await;
                if let Some(mark) = savepoint {
                    let mut shared = shared.lock().await;
                    let tx = shared
                        .as_mut()
                        .ok_or("invocation transaction is finished")?;
                    Box::pin(tx.finish_savepoint(mark, failure_kind(&value).is_some()))
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok(value)
            },
        )
    }
}

fn operations(
    tx: TransactionContext,
    space: DataSpace,
    writable: bool,
    graph: Graph,
    context: CallContext,
) -> Arc<OpRegistry> {
    let mut ops = OpRegistry::new();
    database_operations::register(&mut ops, &tx, &context, space, writable, &graph);

    let CallContext {
        note,
        determinism,
        scope,
        qualified,
    } = context;
    note.register(&mut ops).expect("unique operation");

    if let Some(inputs) = determinism {
        ops.set_determinism(inputs);
    }

    if let Some((plugins, owner)) = graph {
        crate::plugins::register_contract_list(&mut ops, plugins.clone(), owner.clone())
            .expect("unique operation");
        if let Some(hooks) = hooks::QueryHooks::for_target(&plugins, qualified, &note, &tx) {
            ops = ops.with_transforms(hooks);
        }
        ops.register_module_call("plugin.call", move |payload| {
            let resolved = (|| -> Result<_, engine::CallError> {
                if tx.failure.lock().expect("failure lock").is_some() {
                    return Err("An earlier plugin operation failed".into());
                }

                let name = text(&payload, "name").map_err(|e| e.to_string())?;

                let args = field(&payload, "args").map_err(|e| e.to_string())?.clone();

                let target = plugins.target(
                    &owner,
                    name,
                    writable,
                    payload.get("contract").and_then(Json::as_str),
                )?;
                target.kind.check_requested(&payload)?;
                if note.auth.is_none() {
                    target.check_anonymous_scope(&owner)?;
                }

                let child_note = note
                    .enter(name, Some(&target.args), &args)
                    .map_err(|error| engine::CallError {
                        message: error.to_string(),
                        details: None,
                        limit: Some(engine::CallLimit::Depth),
                    })?;

                let child_scope = CallScope::default();
                let ops = operations(
                    tx.clone(),
                    target.space,
                    target.mutation,
                    Some((plugins.clone(), target.owner)),
                    CallContext {
                        determinism: None,
                        note: child_note,
                        scope: child_scope.clone(),
                        qualified: Some(name.to_owned()),
                    },
                );
                let failed = tx.clone();
                let call = ModuleCall::new(
                    target.bundle,
                    "invoke",
                    json!({"name":target.local_name,"args":args}),
                    ops,
                    move |error| failed.poison(error),
                );
                let call = if target.mutation {
                    call
                } else {
                    call.catch_structured()
                };
                Ok(scope
                    .clone()
                    .nest(child_scope, tx.shared.clone(), target.mutation, call))
            })();

            if let Err(error) = &resolved {
                tx.poison(error.clone());
            }
            resolved
        })
        .expect("unique operation");
    }
    Arc::new(ops)
}

mod database_operations;
use database_operations::{field, text};

mod database_queries;
pub(crate) mod hooks;
pub(crate) mod triggers;

mod process_frames;

async fn finish_transaction(
    tx: Transaction,
    result: Result<Json, CallError>,
    mutation: bool,
    observed: &mut Observations,
) -> Result<Json, CallError> {
    match result {
        Ok(value) if !mutation || failure_kind(&value).is_none() => {
            match Box::pin(tx.commit()).await {
                Ok(()) => Ok(value),
                Err(error) => {
                    observed.conflict |= error.is_retryable_conflict();

                    Err(
                        format!("transaction commit failed (outcome may be unknown): {error}")
                            .into(),
                    )
                }
            }
        }
        result => match Box::pin(tx.rollback()).await {
            Ok(()) => result,
            Err(rollback) => {
                // A failed rollback is not evidence that replay is safe.
                observed.conflict = false;

                let message = format!("transaction rollback failed: {rollback}");
                Err(match result {
                    Ok(_) => message.into(),
                    Err(error) => format!("{error}; {message}").into(),
                })
            }
        },
    }
}

fn resolve_invocation(
    bundle: Option<Arc<Bundle>>,
    name: &str,
    space: &DataSpace,
    plugins: Option<Arc<crate::plugins::Loaded>>,
) -> (Arc<Bundle>, String, DataSpace, Graph) {
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
            Some((plugins, target.owner)),
        )
    } else {
        (
            bundle.expect("legacy bundle"),
            name.to_owned(),
            space.clone(),
            None,
        )
    };

    (bundle, name, space, graph)
}

pub(crate) mod action_process;
