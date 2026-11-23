//! One invocation's SDK capabilities, including its explicit caller identity.
//! No SQL or client reaches JavaScript. Futures are boxed at the database boundary to keep the
//! embedded engine's large debug futures off the QuickJS worker's native stack.

use crate::data::{self, DataSpace, Order, Table, Transaction, json_equal, json_object};
use crate::protocol::failure_kind;
use engine::{Bundle, Determinism, ModuleCall, OpRegistry, Pool};
use serde_json::{Value as Json, json};
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard};

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

pub(crate) struct Invocation<'a> {
    pub bundle: Option<Arc<Bundle>>,
    pub name: &'a str,
    pub args: Json,
    pub mutation: bool,
    pub space: &'a DataSpace,
    pub plugins: Option<Arc<crate::plugins::Loaded>>,
    pub determinism: Determinism,
    pub auth: Option<crate::identity::AuthContext>,
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
        auth,
    } = invocation;
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
        CallContext {
            determinism: Some(determinism),
            auth,
            scope: CallScope::default(),
        },
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

    let result = finish_transaction(tx, result, mutation, &mut observed).await;
    Call {
        result,
        reads: std::mem::take(&mut observed.reads),
        conflict: observed.conflict,
    }
}

type Graph = Option<(Arc<crate::plugins::Loaded>, String, Vec<String>)>;

struct CallContext {
    determinism: Option<Determinism>,
    auth: Option<crate::identity::AuthContext>,
    scope: CallScope,
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
    shared: SharedTransaction,
    observations: Arc<Mutex<Observations>>,
    failure: Failure,
    space: DataSpace,
    writable: bool,
    graph: Graph,
    context: CallContext,
) -> Arc<OpRegistry> {
    let CallContext {
        auth,
        determinism,
        scope,
    } = context;
    let mut ops = OpRegistry::new();
    crate::identity::register_caller(auth.as_ref(), &mut ops).expect("unique operation");

    if let Some(inputs) = determinism {
        ops.set_determinism(inputs);
    }
    database_operations::register(
        &mut ops,
        shared.clone(),
        observations.clone(),
        failure.clone(),
        scope.clone(),
        space,
        writable,
    );

    if let Some((plugins, owner, path)) = graph {
        crate::plugins::register_contract_list(&mut ops, plugins.clone(), owner.clone())
            .expect("unique operation");
        ops.register_module("plugin.call", move |payload| {
            let resolved = (|| {
                if failure.lock().expect("failure lock").is_some() {
                    return Err("An earlier plugin operation failed".to_string());
                }

                let name = text(&payload, "name").map_err(|e| e.to_string())?;

                let args = field(&payload, "args").map_err(|e| e.to_string())?.clone();

                let target = plugins.target(
                    &owner,
                    name,
                    writable,
                    &path,
                    payload.get("contract").and_then(Json::as_str),
                )?;
                target.kind.check_requested(&payload)?;
                if auth.is_none() {
                    target.check_anonymous_scope(&owner)?;
                }

                let mut child_path = path.clone();
                child_path.push(name.into());

                let child_scope = CallScope::default();
                let child_ops = operations(
                    shared.clone(),
                    observations.clone(),
                    failure.clone(),
                    target.space,
                    target.mutation,
                    Some((plugins.clone(), target.owner, child_path)),
                    CallContext {
                        determinism: None,
                        auth: auth.clone(),
                        scope: child_scope.clone(),
                    },
                );

                let failed = failure.clone();
                let call = ModuleCall::new(
                    target.bundle,
                    "invoke",
                    json!({"name":target.local_name,"args":args}),
                    child_ops,
                    move |error| {
                        *failed.lock().expect("failure lock") = Some(error);
                    },
                );
                Ok(scope
                    .clone()
                    .nest(child_scope, shared.clone(), target.mutation, call))
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

mod database_operations;
use database_operations::{field, text};

mod database_queries;

pub(crate) mod worker;

async fn finish_transaction(
    tx: Transaction,
    result: Result<Json, String>,
    mutation: bool,
    observed: &mut Observations,
) -> Result<Json, String> {
    match result {
        Ok(value) if !mutation || failure_kind(&value).is_none() => {
            match Box::pin(tx.commit()).await {
                Ok(()) => Ok(value),
                Err(error) => {
                    observed.conflict |= error.is_retryable_conflict();

                    Err(format!(
                        "transaction commit failed (outcome may be unknown): {error}"
                    ))
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
                    Ok(_) => message,
                    Err(error) => format!("{error}; {message}"),
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

    (bundle, name, space, graph)
}

pub(crate) mod action_process;
