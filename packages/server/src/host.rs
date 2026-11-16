//! One invocation's SDK capabilities. No SQL, client, or ambient call identity
//! reaches JavaScript. Futures are boxed at the database boundary to keep the
//! embedded engine's large debug futures off the QuickJS worker's native stack.

use crate::data::{self, DataSpace, Order, Table, Transaction, json_equal, json_object};
use engine::{Bundle, Determinism, ModuleCall, OpRegistry, Pool};
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
    determinism: Determinism,
    caller: crate::members::Caller,
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
        Some(determinism),
        caller,
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
    determinism: Option<Determinism>,
    identity: crate::members::Caller,
) -> Arc<OpRegistry> {
    let mut ops = OpRegistry::new();
    identity.register(&mut ops);

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
                    None,
                    identity.clone(),
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

mod database_operations;
use database_operations::{field, text};

mod database_queries;

pub(crate) mod acp;
