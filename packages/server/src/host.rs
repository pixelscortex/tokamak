//! One invocation's SDK capabilities, including its explicit caller identity.
//! No SQL or client reaches JavaScript. Futures are boxed at the database boundary to keep the
//! embedded engine's large debug futures off the QuickJS worker's native stack.

use crate::data::{self, DataSpace, Order, Table, Transaction, json_equal, json_object};
use engine::{Bundle, Determinism, ModuleCall, OpRegistry, Pool};
use serde_json::{Value as Json, json};
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) use crate::data::ReadSet;

type SharedTransaction = Arc<Mutex<Option<Transaction>>>;
type Failure = Arc<std::sync::Mutex<Option<String>>>;
pub(crate) type NestedFailure = (crate::plugin_log::Log, String, String);
type DeferredFailure = Arc<std::sync::Mutex<Option<NestedFailure>>>;

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
    pub nested_failure: Option<NestedFailure>,
}

pub(crate) struct Invocation<'a> {
    pub bundle: Option<Arc<Bundle>>,
    pub name: &'a str,
    pub args: Json,
    pub mutation: bool,
    pub space: &'a DataSpace,
    pub plugins: Option<Arc<crate::plugins::Loaded>>,
    pub determinism: Determinism,
    pub user: crate::identity::User,
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
        user,
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
                nested_failure: None,
            };
        }
    };

    let shared: SharedTransaction = Arc::new(Mutex::new(Some(tx)));

    let observations = Arc::new(Mutex::new(Observations::default()));

    let failure: Failure = Arc::default();
    let deferred: DeferredFailure = Arc::default();

    let ops = operations(
        shared.clone(),
        observations.clone(),
        failure.clone(),
        space,
        mutation,
        graph,
        CallContext {
            determinism: Some(determinism),
            deferred: deferred.clone(),
            user,
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

    let result = finish_transaction(tx, result, &mut observed).await;
    Call {
        result,
        reads: std::mem::take(&mut observed.reads),
        conflict: observed.conflict,
        nested_failure: deferred.lock().expect("deferred failure lock").take(),
    }
}

type Graph = Option<(Arc<crate::plugins::Loaded>, String, Vec<String>)>;

struct CallContext {
    determinism: Option<Determinism>,
    deferred: DeferredFailure,
    user: crate::identity::User,
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
        user,
        determinism,
        deferred,
    } = context;
    let mut ops = OpRegistry::new();
    let caller_user = user.clone();
    ops.register_sync("user.current", move |_| Ok(json!(caller_user)))
        .expect("unique operation");

    if let Some(inputs) = determinism {
        ops.set_determinism(inputs);
    }
    database_operations::register(
        &mut ops,
        shared.clone(),
        observations.clone(),
        failure.clone(),
        space,
        writable,
    );

    if let Some((plugins, owner, path)) = graph {
        plugins.logs[&owner].console(&mut ops);
        register_providers(&mut ops, plugins.clone(), owner.clone(), failure.clone());
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

                let log = plugins.logs[&target.owner].clone();
                let log_name = target.local_name.clone();
                let child_ops = operations(
                    shared.clone(),
                    observations.clone(),
                    failure.clone(),
                    target.space,
                    target.mutation,
                    Some((plugins.clone(), target.owner, child_path)),
                    CallContext {
                        determinism: None,
                        deferred: deferred.clone(),
                        user: user.clone(),
                    },
                );

                let failed = failure.clone();
                let deferred = deferred.clone();

                Ok(ModuleCall::new(
                    target.bundle,
                    "invoke",
                    json!({"name":target.local_name,"args":args}),
                    child_ops,
                    move |error| {
                        // A parent can observe the same error as it unwinds.
                        // Keep the original function and report only on publication.
                        deferred
                            .lock()
                            .expect("deferred failure lock")
                            .get_or_insert_with(|| (log.clone(), log_name.clone(), error.clone()));
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

fn register_providers(
    ops: &mut OpRegistry,
    plugins: Arc<crate::plugins::Loaded>,
    owner: String,
    failure: Failure,
) {
    ops.register_sync("plugin.providers", move |payload| {
        let result = text(&payload, "interface")
            .map_err(|e| e.to_string())
            .and_then(|interface| {
                plugins
                    .catalog
                    .providers(&owner, interface)
                    .map_err(|e| e.to_string())
            })
            .map(|ids| json!(ids));
        if let Err(error) = &result {
            *failure.lock().expect("failure lock") = Some(error.clone());
        }
        result
    })
    .expect("unique operation");
}

mod database_operations;
use database_operations::{field, text};

mod database_queries;

pub(crate) mod worker;

async fn finish_transaction(
    tx: Transaction,
    result: Result<Json, String>,
    observed: &mut Observations,
) -> Result<Json, String> {
    match result {
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
