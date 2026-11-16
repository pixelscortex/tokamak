//! Regression tests for futures dropped mid-flight: a cancelled `commit` must
//! still finish (or fail) as a whole, and a cancelled mutation must poison its
//! transaction. Host callers (JS invocations, request handlers, `select!`)
//! drop futures routinely, so neither may leave half-applied data, unindexed
//! rows, or missing/duplicate change events.
//!
//! Technique: futures are polled exactly once by hand with the runtime's real
//! waker (`poll_fn` returning the inner `Poll`), the result is ASSERTED to be
//! `Pending`, and only then dropped. A test never counts a `Ready` first poll
//! as a cancellation.
//! - `commit` hands the transaction to a spawned task and awaits its
//!   JoinHandle; on this current-thread runtime the task cannot run before we
//!   yield, so the first poll is always Pending.
//! - Mutations finish synchronously unless something inside them yields. The
//!   only public lever is Tokio's cooperative budget: spending most of it just
//!   before the first poll makes the storage/index work yield partway. Several
//!   budget levels are tried so the drop lands at different points; each
//!   operation must have been Pending at least once, or the test fails.

#[path = "support/data.rs"]
mod support;
use support::{Fixture, table};

use server::data::{ChangeEvent, Database, Error, Object, Result, Table, Value};
use std::{
    future::{Future, poll_fn},
    pin::Pin,
    task::Poll,
    time::Duration,
};
use tokio::sync::broadcast::{Receiver, error::TryRecvError};

fn run<F: std::future::Future<Output = ()>>(scenario: impl FnOnce() -> F + Send + 'static) {
    support::run("tkm83-cancel-test", scenario);
}

macro_rules! backends {
    ($memory:ident, $disk:ident, $behavior:ident) => {
        #[test]
        fn $memory() {
            run(|| $behavior(false));
        }
        #[test]
        fn $disk() {
            run(|| $behavior(true));
        }
    };
}

fn k(value: i64) -> Object {
    let mut object = Object::new();
    object.insert("k", Value::from_int(value));
    object
}

fn keys(rows: &[server::data::Document]) -> Vec<String> {
    let mut keys: Vec<_> = rows.iter().map(|row| row.id.to_string()).collect();
    keys.sort();
    keys
}

/// Poll once with the caller's real waker and report the raw outcome.
async fn poll_once<F: Future + ?Sized>(mut future: Pin<&mut F>) -> Poll<F::Output> {
    poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx))).await
}

/// Leave `128 - units` units of Tokio's cooperative budget for the next poll.
async fn spend_budget(units: usize) {
    tokio::task::yield_now().await;
    for _ in 0..units {
        tokio::task::consume_budget().await;
    }
}

fn drain(events: &mut Receiver<ChangeEvent>) -> Vec<ChangeEvent> {
    let mut seen = Vec::new();
    loop {
        match events.try_recv() {
            Ok(event) => seen.push(event),
            Err(TryRecvError::Empty) => return seen,
            Err(other) => panic!("event channel: {other:?}"),
        }
    }
}

async fn backoff(attempt: usize) {
    assert!(attempt < 5000, "retry loop did not converge");
    if attempt < 4 {
        tokio::task::yield_now().await;
    } else {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// Barrier for a detached commit task: a definition needs the exclusive
/// catalog gate, which every in-flight writer task holds until its storage
/// outcome is final. Awaited rollback returns after the barrier's own task.
async fn settle(db: &Database, scratch: &Table) {
    let mut attempt = 0;
    loop {
        let mut tx = db.begin().await.unwrap();
        match tx.define_index(scratch, "settle", &["k"], false).await {
            Ok(()) => {
                tx.rollback().await.unwrap();
                return;
            }
            Err(error) => {
                assert!(error.is_retryable_conflict(), "{error:?}");
                drop(tx);
            }
        }
        backoff(attempt).await;
        attempt += 1;
    }
}

/// Invariant behind contract A(1): if the index exists, it holds exactly the
/// committed rows. A committed row missing from it is the bug being guarded.
async fn assert_index_complete(db: &Database, table: &Table, index: &str) -> bool {
    let mut read = db.read_only().await.unwrap();
    let rows = read.query(table).collect().await.unwrap();
    read.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    match read.query(table).with_index(index).collect().await {
        Ok(indexed) => {
            assert_eq!(
                keys(&indexed),
                keys(&rows),
                "{table:?} index {index} out of sync"
            );
            read.commit().await.unwrap();
            true
        }
        // Only a missing index may be reported as "no index". Any other error
        // (a dangling or corrupt entry, say) is exactly the damage this
        // invariant exists to catch, so it must fail the test.
        Err(Error::Invalid("the requested index does not exist")) => false,
        Err(error) => panic!("{table:?} index {index} unreadable: {error:?}"),
    }
}

// ---------------------------------------------------------------------------
// A. Cancelled commits.
// ---------------------------------------------------------------------------

const ITERATIONS: usize = 100;

backends!(
    memory_cancelled_definition_commit,
    disk_cancelled_definition_commit,
    cancelled_definition_commit
);

// Contract A: a transaction that defines an index and writes rows has its
// commit future dropped after one Pending poll, at varied points (0-3 yields
// later; the next writer opened before or after the drop; table pre-created or
// not). The detached commit must still apply as a whole and publish exactly
// one event, and a writer racing it must either land in the new index or get
// a retryable conflict whose replay is indexed. Before 857c326 the epoch moved
// on cancellation and a racing writer could commit an unindexed row.
async fn cancelled_definition_commit(disk: bool) {
    let fixture = Fixture::new(disk, "tkm83-cancel-tests");
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let audit = table("audit");
    let mut events = db.subscribe();
    let mut retries = 0usize;
    for n in 0..ITERATIONS {
        let rows = table(&format!("defined{n}"));
        if n % 2 == 0 {
            let mut seed = db.begin().await.unwrap();
            let id = seed.insert(&rows, Object::new()).await.unwrap();
            seed.delete(&id).await.unwrap();
            seed.commit().await.unwrap();
            assert_eq!(drain(&mut events).len(), 1);
        }
        let early = if n % 3 == 0 {
            Some(db.begin().await.unwrap())
        } else {
            None
        };
        let mut ddl = db.begin().await.unwrap();
        ddl.define_index(&rows, "by_k", &["k"], false)
            .await
            .unwrap();
        let first = ddl.insert(&rows, k(0)).await.unwrap();
        let marker = ddl.insert(&audit, k(n as i64)).await.unwrap();
        {
            let mut committing = Box::pin(ddl.commit());
            assert!(
                poll_once(committing.as_mut()).await.is_pending(),
                "iteration {n}: commit was not pending"
            );
            for _ in 0..n % 4 {
                tokio::task::yield_now().await;
            }
        }
        let writer = match early {
            Some(tx) => tx,
            None => db.begin().await.unwrap(),
        };
        let second = {
            let mut attempt = 0;
            let mut tx = writer;
            loop {
                match tx.insert(&rows, k(1)).await {
                    Ok(id) => match tx.commit().await {
                        Ok(()) => break id,
                        Err(error) => assert!(error.is_retryable_conflict(), "{error:?}"),
                    },
                    Err(error) => {
                        assert!(error.is_retryable_conflict(), "{error:?}");
                        tx.rollback().await.unwrap();
                    }
                }
                retries += 1;
                backoff(attempt).await;
                attempt += 1;
                tx = db.begin().await.unwrap();
            }
        };
        // The writer's success implies the definer's task released the
        // catalog gate, so its outcome (and event) is final by now.
        let mut read = db.read_only().await.unwrap();
        let committed = read.get(&first).await.unwrap().is_some();
        assert_eq!(
            read.get(&marker).await.unwrap().is_some(),
            committed,
            "iteration {n}: partial commit"
        );
        assert!(read.get(&second).await.unwrap().is_some());
        read.commit().await.unwrap();
        // Nothing contends with the definer's own commit, so it must succeed.
        assert!(committed, "iteration {n}: cancelled commit was lost");
        let published = drain(&mut events);
        assert_eq!(published.len(), 2, "iteration {n}: {published:?}");
        assert_eq!(published[0].tables, vec![audit.clone(), rows.clone()]);
        assert_eq!(published[0].records.as_ref().map(Vec::len), Some(2));
        assert_eq!(published[1].tables, vec![rows.clone()]);
        assert!(
            assert_index_complete(&db, &rows, "by_k").await,
            "iteration {n}: index missing"
        );
        let mut read = db.read_only().await.unwrap();
        assert_eq!(
            read.query(&rows)
                .with_index("by_k")
                .eq("k", 1i64)
                .collect()
                .await
                .unwrap()
                .len(),
            1
        );
        read.commit().await.unwrap();
    }
    eprintln!(
        "cancelled_definition_commit disk={disk}: {ITERATIONS} iterations, {retries} retryable conflicts"
    );
    db.close().await.unwrap();
}

backends!(
    memory_cancelled_row_commit,
    disk_cancelled_row_commit,
    cancelled_row_commit
);

// Contract A, inverse race: a row commit is dropped after one Pending poll,
// then another call tries to define an index on that (otherwise empty) table.
// The definition must never succeed while the row commits, or the row would
// be silently missing from the new index; data is all-or-nothing; the
// detached commit publishes exactly one event (none if it failed).
async fn cancelled_row_commit(disk: bool) {
    let fixture = Fixture::new(disk, "tkm83-cancel-tests");
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let audit = table("audit");
    let scratch = table("scratch");
    let mut events = db.subscribe();
    let (mut committed_count, mut definitions) = (0, 0);
    for n in 0..ITERATIONS {
        let rows = table(&format!("rows{n}"));
        if n % 2 == 0 {
            let mut seed = db.begin().await.unwrap();
            let id = seed.insert(&rows, Object::new()).await.unwrap();
            seed.delete(&id).await.unwrap();
            seed.commit().await.unwrap();
            assert_eq!(drain(&mut events).len(), 1);
        }
        let mut writer = db.begin().await.unwrap();
        let row = writer.insert(&rows, k(1)).await.unwrap();
        let marker = writer.insert(&audit, k(n as i64)).await.unwrap();
        let early = if n % 3 == 0 {
            Some(db.begin().await.unwrap())
        } else {
            None
        };
        {
            let mut committing = Box::pin(writer.commit());
            assert!(
                poll_once(committing.as_mut()).await.is_pending(),
                "iteration {n}: commit was not pending"
            );
            for _ in 0..n % 4 {
                tokio::task::yield_now().await;
            }
        }
        let mut definer = match early {
            Some(tx) => tx,
            None => db.begin().await.unwrap(),
        };
        match definer.define_index(&rows, "by_k", &["k"], false).await {
            Ok(()) => {
                definitions += 1;
                if let Err(error) = definer.commit().await {
                    assert!(error.is_retryable_conflict(), "{error:?}");
                }
            }
            Err(error) => {
                assert!(
                    error.is_retryable_conflict() || matches!(error, Error::Invalid(_)),
                    "{error:?}"
                );
                assert!(matches!(
                    definer.commit().await,
                    Err(Error::FailedTransaction)
                ));
            }
        }
        settle(&db, &scratch).await;
        let mut read = db.read_only().await.unwrap();
        let committed = read.get(&row).await.unwrap().is_some();
        assert_eq!(
            read.get(&marker).await.unwrap().is_some(),
            committed,
            "iteration {n}: partial commit"
        );
        read.commit().await.unwrap();
        let published = drain(&mut events);
        if committed {
            committed_count += 1;
            assert_eq!(published.len(), 1, "iteration {n}: {published:?}");
            assert_eq!(published[0].tables, vec![audit.clone(), rows.clone()]);
        } else {
            assert!(published.is_empty(), "iteration {n}: {published:?}");
        }
        assert_index_complete(&db, &rows, "by_k").await;
    }
    eprintln!(
        "cancelled_row_commit disk={disk}: {committed_count}/{ITERATIONS} detached commits applied, {definitions} definitions accepted"
    );
    // Nothing contends with the writer's storage commit; losing it is a bug.
    assert_eq!(committed_count, ITERATIONS);
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// B. Cancelled mutations.
// ---------------------------------------------------------------------------

const INDEXES: usize = 60;
const BUDGETS: [usize; 8] = [127, 126, 124, 120, 112, 96, 64, 0];

#[derive(Clone, Copy, Debug)]
enum Op {
    Insert,
    Patch,
    Replace,
    Delete,
    DefineIndex,
}

backends!(
    memory_cancelled_mutations_poison,
    disk_cancelled_mutations_poison,
    cancelled_mutations_poison
);

// Contract B: a mutation future dropped after a Pending poll (here midway
// through maintaining 60 indexes) must poison its transaction. Otherwise a
// host that catches the cancellation could commit a half-indexed row, or a
// patch whose old index entries were removed but new ones never written.
// After the poison, neither that write nor an earlier successful write in the
// same transaction may exist, by unindexed scan or by any index, and no event
// may be published.
async fn cancelled_mutations_poison(disk: bool) {
    let fixture = Fixture::new(disk, "tkm83-cancel-tests");
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let rows = table("rows");
    let side = table("side");
    let names: Vec<String> = (0..INDEXES).map(|i| format!("by_k{i}")).collect();
    let mut setup = db.begin().await.unwrap();
    for name in &names {
        setup
            .define_index(&rows, name, &["k"], false)
            .await
            .unwrap();
    }
    let seed = setup.insert(&rows, k(1)).await.unwrap();
    setup.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    let original = read.get(&seed).await.unwrap().unwrap();
    read.commit().await.unwrap();
    let mut events = db.subscribe();

    for op in [
        Op::Insert,
        Op::Patch,
        Op::Replace,
        Op::Delete,
        Op::DefineIndex,
    ] {
        let mut pending = 0;
        for (attempt, budget) in BUDGETS.into_iter().enumerate() {
            let fresh = table(&format!("fresh_{op:?}_{attempt}").to_lowercase());
            let mut tx = db.begin().await.unwrap();
            let early = tx.insert(&side, k(9)).await.unwrap();
            spend_budget(budget).await;
            let first = {
                let mut future: Pin<Box<dyn Future<Output = Result<()>> + '_>> = match op {
                    Op::Insert => Box::pin(async { tx.insert(&rows, k(2)).await.map(drop) }),
                    Op::Patch => Box::pin(tx.patch(&seed, k(2))),
                    Op::Replace => Box::pin(tx.replace(&seed, k(2))),
                    Op::Delete => Box::pin(tx.delete(&seed)),
                    Op::DefineIndex => Box::pin(tx.define_index(&fresh, "by_k", &["k"], false)),
                };
                poll_once(future.as_mut())
                    .await
                    .map(|result| result.unwrap())
                // `future` is dropped here; if Pending, mid-flight.
            };
            if first.is_ready() {
                // Completed without yielding at this budget: not a cancellation.
                tx.rollback().await.unwrap();
                continue;
            }
            pending += 1;
            assert!(
                matches!(tx.get(&seed).await, Err(Error::FailedTransaction)),
                "{op:?} budget {budget}: later operation was allowed"
            );
            assert!(
                matches!(tx.commit().await, Err(Error::FailedTransaction)),
                "{op:?} budget {budget}: commit was allowed"
            );
            let mut read = db.read_only().await.unwrap();
            assert_eq!(
                read.get(&early).await.unwrap(),
                None,
                "{op:?}: earlier write saved"
            );
            assert!(read.query(&side).collect().await.unwrap().is_empty());
            assert_eq!(
                read.query(&rows).collect().await.unwrap(),
                vec![original.clone()],
                "{op:?} budget {budget}: table changed"
            );
            for name in &names {
                assert_eq!(
                    keys(&read.query(&rows).with_index(name).collect().await.unwrap()),
                    vec![seed.to_string()],
                    "{op:?} budget {budget}: index {name} changed"
                );
                assert!(
                    read.query(&rows)
                        .with_index(name)
                        .eq("k", 2i64)
                        .collect()
                        .await
                        .unwrap()
                        .is_empty()
                );
            }
            read.commit().await.unwrap();
            if matches!(op, Op::DefineIndex) {
                let mut read = db.read_only().await.unwrap();
                assert!(
                    read.query(&fresh)
                        .with_index("by_k")
                        .collect()
                        .await
                        .is_err(),
                    "cancelled definition persisted"
                );
            }
            assert!(
                drain(&mut events).is_empty(),
                "{op:?}: poisoned call published"
            );
        }
        eprintln!(
            "{op:?} disk={disk}: {pending}/{} first polls pending",
            BUDGETS.len()
        );
        assert!(
            pending > 0,
            "{op:?} never yielded mid-flight; the cancellation case was not exercised"
        );
    }

    // A later, ordinary transaction still works and publishes once.
    let mut tx = db.begin().await.unwrap();
    tx.patch(&seed, k(3)).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(drain(&mut events).len(), 1);
    db.close().await.unwrap();
}

backends!(
    memory_cancelled_reads_keep_transaction,
    disk_cancelled_reads_keep_transaction,
    cancelled_reads_keep_transaction
);

// Contract B: reads stage nothing, so dropping a query mid-flight must NOT
// poison. (A single `get` never yields at any budget level on either backend,
// so it cannot be cancelled mid-flight through the public API; it is not
// asserted here rather than passing vacuously.) A host that abandons a slow read (a timeout, a superseded
// subscription) must still be able to write and commit in that invocation.
async fn cancelled_reads_keep_transaction(disk: bool) {
    let fixture = Fixture::new(disk, "tkm83-cancel-tests");
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let rows = table("rows");
    let saved = table("saved");
    let mut setup = db.begin().await.unwrap();
    for i in 0..INDEXES {
        setup
            .define_index(&rows, &format!("by_k{i}"), &["k"], false)
            .await
            .unwrap();
    }
    let mut seeds = Vec::new();
    for value in 0..200 {
        seeds.push(setup.insert(&rows, k(value)).await.unwrap());
    }
    setup.commit().await.unwrap();
    let mut events = db.subscribe();

    for read in ["scan", "indexed"] {
        let mut pending = 0;
        for budget in BUDGETS {
            let mut tx = db.begin().await.unwrap();
            spend_budget(budget).await;
            let first = {
                let mut future: Pin<Box<dyn Future<Output = Result<()>> + '_>> = match read {
                    "scan" => Box::pin(async { tx.query(&rows).collect().await.map(drop) }),
                    _ => Box::pin(async {
                        tx.query(&rows)
                            .with_index("by_k5")
                            .gte("k", 10i64)
                            .collect()
                            .await
                            .map(drop)
                    }),
                };
                poll_once(future.as_mut())
                    .await
                    .map(|result| result.unwrap())
            };
            if first.is_ready() {
                tx.rollback().await.unwrap();
                continue;
            }
            pending += 1;
            assert!(
                tx.get(&seeds[0]).await.unwrap().is_some(),
                "{read}: transaction poisoned"
            );
            let id = tx.insert(&saved, k(budget as i64)).await.unwrap();
            tx.commit().await.unwrap();
            assert_eq!(drain(&mut events).len(), 1);
            let mut check = db.read_only().await.unwrap();
            assert!(check.get(&id).await.unwrap().is_some());
            check.commit().await.unwrap();
        }
        eprintln!(
            "{read} disk={disk}: {pending}/{} first polls pending",
            BUDGETS.len()
        );
        assert!(
            pending > 0,
            "{read} never yielded mid-flight; the cancellation case was not exercised"
        );
    }
    db.close().await.unwrap();
}
