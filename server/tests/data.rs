//! Acceptance tests for the native storage boundary, using actual embedded engines.
//! No SQL/client escape hatch is used: these are the calls a future host retains
//! across awaits. Completed commits are event barriers, not timing guesses.

use server::data::{ChangeEvent, Database, Error, Id, Object, Order, Storage, Table, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::sync::broadcast::{Receiver, error::TryRecvError};

struct Fixture {
    storage: Storage,
    directory: Option<PathBuf>,
}

impl Fixture {
    fn new(disk: bool) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        if !disk {
            return Self {
                storage: Storage::Memory,
                directory: None,
            };
        }
        // Test-owned workspace only; create_dir fails rather than reusing an
        // existing directory. Cleanup never traverses an external temp root.
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/tkm3-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let directory = parent.join(format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        Self {
            storage: Storage::Disk(directory.join("database")),
            directory: Some(directory),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(directory) = &self.directory {
            // Every successful test awaits Database::close before this guard.
            std::fs::remove_dir_all(directory).expect("remove this test's owned directory");
        }
    }
}

fn fields(entries: &[(&str, Value)]) -> Object {
    let mut object = Object::new();
    for (key, value) in entries {
        object.insert(*key, value.clone());
    }
    object
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}

fn table(name: &str) -> Table {
    Table::new(name).unwrap()
}

fn empty(events: &mut Receiver<ChangeEvent>) {
    assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
}

fn event(events: &mut Receiver<ChangeEvent>, names: &[&str]) {
    assert_eq!(
        events.try_recv().unwrap().tables,
        names.iter().map(|name| table(name)).collect::<Vec<_>>()
    );
    // Commit sends synchronously before returning; this proves one event, not
    // merely that one eventually arrived. Lag/closure also fail this assertion.
    empty(events);
}

// Debug embedded queries overflowed libtest's default 2 MiB stack on macOS;
// the isolated query passed with 4 MiB. Give debug scenarios 8 MiB of headroom
// without changing global environment/production configuration. Release tests
// deliberately use the default libtest thread, so this is not a claim that the
// future host can ignore its runtime/thread stack. Panics propagate to libtest.
fn run<F: std::future::Future<Output = ()>>(scenario: impl FnOnce() -> F + Send + 'static) {
    fn execute<F: std::future::Future<Output = ()>>(scenario: impl FnOnce() -> F) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(scenario());
    }
    #[cfg(debug_assertions)]
    {
        let result = std::thread::Builder::new()
            .name("tkm3-embedded-test".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || execute(scenario))
            .unwrap()
            .join();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
    #[cfg(not(debug_assertions))]
    execute(scenario);
}

// Each behavior runs once per actual backend, not against a fake transaction.
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

backends!(memory_crud, disk_crud, crud);
backends!(memory_queries, disk_queries, queries);
backends!(
    memory_commit_footprints,
    disk_commit_footprints,
    commit_footprints
);
backends!(memory_failed_calls, disk_failed_calls, failed_calls);
backends!(
    memory_sdk_validation_failure,
    disk_sdk_validation_failure,
    sdk_validation_failure
);
backends!(
    memory_snapshots_and_conflicts,
    disk_snapshots_and_conflicts,
    snapshots_and_conflicts
);

backends!(
    memory_storage_normalized_noops,
    disk_storage_normalized_noops,
    storage_normalized_noops
);

// Failure mode: NONE removes a stored field rather than persisting a value.
// Compare whole documents to prove these patch/replace calls are storage no-ops;
// a later positive commit is the barrier proving neither queued a false event.
async fn storage_normalized_noops(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("todos");
    let mut seed = db.begin().await.unwrap();
    let id = seed.insert(&todos, Object::new()).await.unwrap();
    let original = seed.get(&id).await.unwrap().unwrap();
    seed.commit().await.unwrap();
    let mut events = db.subscribe();

    let normalized = fields(&[("absent", Value::None)]);
    let mut patch = db.begin().await.unwrap();
    patch.patch(&id, normalized.clone()).await.unwrap();
    assert_eq!(patch.get(&id).await.unwrap(), Some(original.clone()));
    patch.commit().await.unwrap();
    let mut replace = db.begin().await.unwrap();
    replace.replace(&id, normalized).await.unwrap();
    assert_eq!(replace.get(&id).await.unwrap(), Some(original.clone()));
    replace.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert_eq!(read.get(&id).await.unwrap(), Some(original));
    read.commit().await.unwrap();
    let mut barrier = db.begin().await.unwrap();
    barrier
        .insert(&table("barrier"), Object::new())
        .await
        .unwrap();
    barrier.commit().await.unwrap();
    // Close before asserting events, so even a regression releases the real
    // disk engine before fixture cleanup during the assertion panic.
    db.close().await.unwrap();
    assert_eq!(events.try_recv().unwrap().tables, vec![table("barrier")]);
    assert_eq!(events.try_recv(), Err(TryRecvError::Closed));
}

// Failure mode: cancelling a pending close must not make its retry report
// completion while the disk engine still holds its lock. Poll exactly once on
// this current-thread runtime, without yielding to the engine, to cancel the
// genuinely pending path. Awaiting the retry must be the shutdown barrier.
#[test]
fn cancelled_disk_close_retry_awaits_shutdown() {
    run(cancelled_disk_close);
}

async fn cancelled_disk_close() {
    use std::{
        future::{Future, poll_fn},
        task::Poll,
    };

    let fixture = Fixture::new(true);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    let id = tx
        .insert(&table("todos"), fields(&[("saved", Value::Bool(true))]))
        .await
        .unwrap();
    let original = tx.get(&id).await.unwrap().unwrap();
    tx.commit().await.unwrap();

    let mut closing = Box::pin(db.close());
    let first_poll = poll_fn(|cx| Poll::Ready(closing.as_mut().poll(cx))).await;
    assert!(
        matches!(first_poll, Poll::Pending),
        "fixture did not exercise cancellation of a pending close: {first_poll:?}"
    );
    drop(closing);
    db.close().await.unwrap();
    // No sleep/retry loop: a successful awaited close is the contract's barrier
    // for immediately reacquiring the disk directory through a fresh owner.
    let mut reopened = Database::open(fixture.storage.clone()).await.unwrap();
    let mut read = reopened.read_only().await.unwrap();
    assert_eq!(read.get(&id).await.unwrap(), Some(original));
    read.commit().await.unwrap();
    reopened.close().await.unwrap();
}

// Host integration regression: a transaction must fit the actual ownership
// shape of Send + Sync + 'static host callbacks returning Send + 'static
// futures. The callback reads real uncommitted state across separate calls;
// neither it nor the mutex may accidentally route reads outside that call.
#[test]
fn owned_transaction_survives_static_host_calls() {
    run(owned_host_calls);
}

async fn owned_host_calls() {
    use server::data::{Document, Transaction};
    use std::{future::Future, sync::Arc};
    use tokio::sync::Mutex;

    fn host_op<F, Fut>(op: F) -> F
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = server::data::Result<Option<Document>>> + Send + 'static,
    {
        op
    }

    let mut db = Database::open(Storage::Memory).await.unwrap();
    let mut events = db.subscribe();
    let mut tx = db.begin().await.unwrap();
    let id = tx
        .insert(&table("todos"), fields(&[("done", Value::Bool(false))]))
        .await
        .unwrap();
    let shared: Arc<Mutex<Option<Transaction>>> = Arc::new(Mutex::new(Some(tx)));
    let op = host_op({
        let shared = Arc::clone(&shared);
        let id = id.clone();
        move || {
            let shared = Arc::clone(&shared);
            let id = id.clone();
            async move {
                shared
                    .lock()
                    .await
                    .as_mut()
                    .expect("invocation still active")
                    .get(&id)
                    .await
            }
        }
    });
    let first = tokio::spawn(op()).await.unwrap().unwrap().unwrap();
    assert_eq!(first.fields.get("done"), Some(&Value::Bool(false)));
    assert!(matches!(db.close().await, Err(Error::Busy)));
    shared
        .lock()
        .await
        .as_mut()
        .unwrap()
        .patch(&id, fields(&[("done", Value::Bool(true))]))
        .await
        .unwrap();
    let second = tokio::spawn(op()).await.unwrap().unwrap().unwrap();
    assert_eq!(second.fields.get("done"), Some(&Value::Bool(true)));
    assert_eq!(second.id, first.id);
    assert_eq!(second.creation_time, first.creation_time);
    let mut outside = db.read_only().await.unwrap();
    assert_eq!(outside.get(&id).await.unwrap(), None);
    outside.commit().await.unwrap();
    empty(&mut events);
    shared.lock().await.take().unwrap().commit().await.unwrap();
    event(&mut events, &["todos"]);
    // The still-owned callback and empty mutex must not pin the DB after commit.
    db.close().await.unwrap();
}

// Shutdown regression: Busy must leave the owner/transactions usable, and each
// completion path must release its ownership. A real disk reopen proves close
// released the engine, not merely that it marked the wrapper closed.
#[test]
fn busy_close_recovers_after_commit_rollback_and_drop() {
    run(recoverable_shutdown);
}

async fn recoverable_shutdown() {
    let fixture = Fixture::new(true);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let mut events = db.subscribe();
    let mut committed = db.begin().await.unwrap();
    let id = committed
        .insert(&table("saved"), Object::new())
        .await
        .unwrap();
    assert!(matches!(db.close().await, Err(Error::Busy)));
    assert!(committed.get(&id).await.unwrap().is_some());
    committed.commit().await.unwrap();
    event(&mut events, &["saved"]);

    let mut discarded = db.begin().await.unwrap();
    let rolled_back = discarded
        .insert(&table("discarded"), Object::new())
        .await
        .unwrap();
    let dropped = db.read_only().await.unwrap();
    assert!(matches!(db.close().await, Err(Error::Busy)));
    discarded.rollback().await.unwrap();
    // A read-only invocation is an owner too; rolling back another transaction
    // cannot let shutdown cut its snapshot out from under it.
    assert!(matches!(db.close().await, Err(Error::Busy)));
    drop(dropped);
    db.close().await.unwrap();
    assert_eq!(events.try_recv(), Err(TryRecvError::Closed));
    assert!(matches!(db.begin().await, Err(Error::Closed)));
    assert!(matches!(db.read_only().await, Err(Error::Closed)));
    assert_eq!(db.subscribe().try_recv(), Err(TryRecvError::Closed));
    db.close().await.unwrap();

    let mut reopened = Database::open(fixture.storage.clone()).await.unwrap();
    let mut read = reopened.read_only().await.unwrap();
    assert!(read.get(&id).await.unwrap().is_some());
    assert_eq!(read.get(&rolled_back).await.unwrap(), None);
    read.commit().await.unwrap();
    reopened.close().await.unwrap();
}

// Acceptance: fixed CRUD preserves identity/time, patch merges, replace removes
// omitted fields, and business `id`/`data` survive the private storage envelope.
async fn crud(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("todos");
    let mut tx = db.begin().await.unwrap();
    assert!(tx.query(&todos).collect().await.unwrap().is_empty());
    let original = fields(&[
        ("id", text("business-id")),
        ("data", text("business-data")),
        ("keep", Value::Bool(true)),
    ]);
    let id = tx.insert(&todos, original.clone()).await.unwrap();
    assert_eq!(id.to_string().parse::<Id>().unwrap(), id);
    let before = tx.get(&id).await.unwrap().unwrap();
    assert_eq!(before.fields, original);
    assert!(before.creation_time > 0);
    tx.patch(
        &id,
        fields(&[("id", text("patched")), ("added", Value::Null)]),
    )
    .await
    .unwrap();
    let patched = tx.get(&id).await.unwrap().unwrap();
    assert_eq!(patched.id, before.id);
    assert_eq!(patched.creation_time, before.creation_time);
    let mut expected = original;
    expected.insert("id", "patched");
    expected.insert("added", Value::Null);
    assert_eq!(patched.fields, expected);
    let replacement = fields(&[
        ("id", text("replacement")),
        ("data", Value::Object(fields(&[("nested", text("kept"))]))),
    ]);
    tx.replace(&id, replacement.clone()).await.unwrap();
    let after = tx.get(&id).await.unwrap().unwrap();
    assert_eq!(after.id, before.id);
    assert_eq!(after.creation_time, before.creation_time);
    assert_eq!(after.fields, replacement);
    tx.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert_eq!(read.get(&id).await.unwrap(), Some(after));
    read.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.delete(&id).await.unwrap();
    assert_eq!(tx.get(&id).await.unwrap(), None);
    tx.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert_eq!(read.get(&id).await.unwrap(), None);
    read.commit().await.unwrap();
    db.close().await.unwrap();
}

// Acceptance/security: equality is AND, metadata and envelope fields resolve
// correctly, values stay data, and every terminal applies creation-time order
// and limits consistently. SQL keywords themselves are legal identifiers.
async fn queries(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("select");
    let payload = "'; DELETE select; RETURN true; -- \" \\ 雪";
    let mut tx = db.begin().await.unwrap();
    let mut inserted = Vec::new();
    for (group, done) in [("a", false), ("a", true), ("b", false), ("a", false)] {
        let id = tx
            .insert(
                &todos,
                fields(&[
                    ("group", text(group)),
                    ("done", Value::Bool(done)),
                    ("id", text(payload)),
                    ("data", text("ordinary")),
                ]),
            )
            .await
            .unwrap();
        inserted.push(tx.get(&id).await.unwrap().unwrap());
    }
    tx.commit().await.unwrap();
    // The public contract exposes the tie-breaker, but not a caller-controlled
    // clock. Compare both keys even if this run has no same-millisecond pair.
    inserted.sort_by_key(|row| (row.creation_time, row.id.to_string()));
    let mut tx = db.read_only().await.unwrap();
    assert_eq!(tx.query(&todos).collect().await.unwrap(), inserted);
    let mut descending = inserted.clone();
    descending.reverse();
    assert_eq!(
        tx.query(&todos).order(Order::Desc).collect().await.unwrap(),
        descending
    );
    assert_eq!(
        tx.query(&todos).limit(2).collect().await.unwrap(),
        inserted[..2]
    );
    assert_eq!(
        tx.query(&todos).order(Order::Desc).take(2).await.unwrap(),
        descending[..2]
    );
    assert_eq!(
        tx.query(&todos).first().await.unwrap(),
        Some(inserted[0].clone())
    );
    assert_eq!(
        tx.query(&todos).order(Order::Desc).first().await.unwrap(),
        Some(descending[0].clone())
    );
    assert_eq!(tx.query(&todos).limit(0).first().await.unwrap(), None);
    assert!(tx.query(&todos).take(0).await.unwrap().is_empty());
    assert_eq!(tx.query(&todos).take(100).await.unwrap(), inserted);
    let expected: Vec<_> = inserted
        .iter()
        .filter(|row| {
            row.fields.get("group") == Some(&text("a"))
                && row.fields.get("done") == Some(&Value::Bool(false))
        })
        .cloned()
        .collect();
    assert_eq!(
        tx.query(&todos)
            .eq("group", "a")
            .eq("done", false)
            .collect()
            .await
            .unwrap(),
        expected
    );
    assert_eq!(
        tx.query(&todos)
            .eq("id", payload)
            .eq("data", "ordinary")
            .collect()
            .await
            .unwrap(),
        inserted
    );
    assert!(
        tx.query(&todos)
            .eq("id", "' OR true; DELETE select; --")
            .collect()
            .await
            .unwrap()
            .is_empty()
    );
    let chosen = &inserted[1];
    assert_eq!(
        tx.query(&todos)
            .eq("_id", chosen.id.to_string())
            .collect()
            .await
            .unwrap(),
        vec![chosen.clone()]
    );
    assert_eq!(
        tx.query(&todos)
            .eq("_creationTime", chosen.creation_time)
            .collect()
            .await
            .unwrap(),
        inserted
            .iter()
            .filter(|row| row.creation_time == chosen.creation_time)
            .cloned()
            .collect::<Vec<_>>()
    );
    assert_eq!(
        tx.query(&todos)
            .eq("group", "missing")
            .first()
            .await
            .unwrap(),
        None
    );
    assert!(
        tx.get(&"select:000123".parse().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    tx.commit().await.unwrap();
    db.close().await.unwrap();
}

// Failure mode: statement-level writes must not leak early/per-operation events.
// One committed footprint deduplicates/sorts tables, including insert+delete;
// rollback, reads, identical updates and missing deletes publish nothing.
async fn commit_footprints(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let mut events = db.subscribe();
    let mut second = db.subscribe();
    let alpha = table("alpha");
    let zeta = table("zeta");
    let mut tx = db.begin().await.unwrap();
    let id = tx
        .insert(&zeta, fields(&[("done", Value::Bool(false))]))
        .await
        .unwrap();
    let transient = tx.insert(&alpha, Object::new()).await.unwrap();
    tx.delete(&transient).await.unwrap();
    tx.patch(&id, fields(&[("done", Value::Bool(true))]))
        .await
        .unwrap();
    empty(&mut events);
    tx.commit().await.unwrap();
    event(&mut events, &["alpha", "zeta"]);
    event(&mut second, &["alpha", "zeta"]);
    let mut tx = db.begin().await.unwrap();
    let same = tx.get(&id).await.unwrap().unwrap().fields;
    tx.patch(&id, Object::new()).await.unwrap();
    tx.patch(&id, same.clone()).await.unwrap();
    tx.replace(&id, same).await.unwrap();
    tx.delete(&transient).await.unwrap();
    tx.commit().await.unwrap();
    empty(&mut events);
    let mut tx = db.begin().await.unwrap();
    tx.delete(&id).await.unwrap();
    tx.insert(&alpha, Object::new()).await.unwrap();
    tx.rollback().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert!(read.get(&id).await.unwrap().is_some());
    assert!(read.query(&alpha).collect().await.unwrap().is_empty());
    read.commit().await.unwrap();
    empty(&mut events);
    // A positive later commit is a barrier: none of the silent transactions
    // may have queued an event, and publication is still working afterwards.
    let mut tx = db.begin().await.unwrap();
    tx.delete(&id).await.unwrap();
    tx.commit().await.unwrap();
    event(&mut events, &["zeta"]);
    db.close().await.unwrap();
}

// Failure mode: a caught operation error must poison the invocation rather
// than permitting a partially committed mutation. Also guards all three write
// entry points against forged SDK metadata and the query identifier boundary.
async fn failed_calls(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("todos");
    let mut events = db.subscribe();
    for operation in [
        "insert_id",
        "patch_time",
        "replace_id",
        "field",
        "id_filter",
        "missing_patch",
        "missing_replace",
    ] {
        let mut tx = db.begin().await.unwrap();
        let id = tx.insert(&todos, Object::new()).await.unwrap();
        let error = match operation {
            "insert_id" => tx
                .insert(&todos, fields(&[("_id", text("todos:forged"))]))
                .await
                .unwrap_err(),
            "patch_time" => tx
                .patch(&id, fields(&[("_creationTime", Value::from_int(1))]))
                .await
                .unwrap_err(),
            "replace_id" => tx
                .replace(&id, fields(&[("_id", text("todos:forged"))]))
                .await
                .unwrap_err(),
            "field" => tx
                .query(&todos)
                .eq("done) OR true; DELETE todos; --", false)
                .collect()
                .await
                .unwrap_err(),
            "id_filter" => tx
                .query(&todos)
                .eq("_id", "todos:a; DELETE todos")
                .collect()
                .await
                .unwrap_err(),
            "missing_patch" => tx
                .patch(&"todos:missing".parse().unwrap(), Object::new())
                .await
                .unwrap_err(),
            "missing_replace" => tx
                .replace(&"todos:missing".parse().unwrap(), Object::new())
                .await
                .unwrap_err(),
            _ => unreachable!(),
        };
        assert!(!error.is_retryable_conflict(), "{operation}: {error}");
        assert!(matches!(error, Error::Invalid(_) | Error::MissingRecord));
        assert!(matches!(
            tx.query(&todos).limit(0).collect().await,
            Err(Error::FailedTransaction)
        ));
        assert!(matches!(tx.commit().await, Err(Error::FailedTransaction)));
        let mut read = db.read_only().await.unwrap();
        assert!(
            read.query(&todos).collect().await.unwrap().is_empty(),
            "partial commit: {operation}"
        );
        read.commit().await.unwrap();
        empty(&mut events);
    }
    let mut tx = db.begin().await.unwrap();
    tx.insert(&todos, Object::new()).await.unwrap();
    tx.commit().await.unwrap();
    event(&mut events, &["todos"]);
    db.close().await.unwrap();
}

// Failure mode: errors returned by public-SDK validation (before SQL executes)
// must poison a call just like wrapper validation and engine statement errors.
async fn sdk_validation_failure(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("todos");
    let mut events = db.subscribe();
    let mut tx = db.begin().await.unwrap();
    let id = tx.insert(&todos, Object::new()).await.unwrap();
    let mut nested = Value::Null;
    for _ in 0..256 {
        nested = Value::Object(fields(&[("child", nested)]));
    }
    let error = tx
        .insert(&todos, fields(&[("nested", nested)]))
        .await
        .unwrap_err();
    assert!(matches!(&error, Error::Database(_)), "{error:?}");
    assert!(!error.is_retryable_conflict());
    assert!(matches!(tx.commit().await, Err(Error::FailedTransaction)));
    let mut read = db.read_only().await.unwrap();
    assert_eq!(read.get(&id).await.unwrap(), None);
    assert!(read.query(&todos).collect().await.unwrap().is_empty());
    read.commit().await.unwrap();
    let mut barrier = db.begin().await.unwrap();
    barrier
        .insert(&table("barrier"), Object::new())
        .await
        .unwrap();
    barrier.commit().await.unwrap();
    event(&mut events, &["barrier"]);
    db.close().await.unwrap();
}

// Failure injection only, not schema feature coverage: prepare a rejecting
// ASSERT through the public SDK, close it, then exercise the normal data API.
// This forces an actual SQL statement error inside an otherwise successful SDK
// response, proving that catching it cannot commit the earlier successful write.
#[test]
fn disk_statement_error_cannot_commit_partial_call() {
    run(disk_statement_error);
}

async fn disk_statement_error() {
    let fixture = Fixture::new(true);
    let Storage::Disk(path) = &fixture.storage else {
        unreachable!()
    };
    let setup =
        surrealdb::Surreal::new::<surrealdb::engine::local::SurrealKv>(path.to_str().unwrap())
            .await
            .unwrap();
    setup.use_ns("tokamak").use_db("tokamak").await.unwrap();
    setup
        .query("DEFINE TABLE todos SCHEMALESS; DEFINE FIELD data ON TABLE todos TYPE object; DEFINE FIELD data.reject ON TABLE todos TYPE option<bool> ASSERT $value != true;")
        .await
        .unwrap()
        .check()
        .unwrap();
    setup.shutdown().await.unwrap();
    drop(setup);

    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("todos");
    let mut events = db.subscribe();
    let mut tx = db.begin().await.unwrap();
    let id = tx.insert(&todos, Object::new()).await.unwrap();
    let error = tx
        .insert(&todos, fields(&[("reject", Value::Bool(true))]))
        .await
        .unwrap_err();
    assert!(matches!(&error, Error::Database(_)), "{error:?}");
    assert!(
        error.to_string().contains("data.reject"),
        "expected injected field assertion: {error:?}"
    );
    assert!(!error.is_retryable_conflict());
    assert!(matches!(tx.commit().await, Err(Error::FailedTransaction)));
    let mut read = db.read_only().await.unwrap();
    assert_eq!(read.get(&id).await.unwrap(), None);
    assert!(read.query(&todos).collect().await.unwrap().is_empty());
    read.commit().await.unwrap();
    let mut barrier = db.begin().await.unwrap();
    barrier
        .insert(&table("barrier"), Object::new())
        .await
        .unwrap();
    barrier.commit().await.unwrap();
    event(&mut events, &["barrier"]);
    db.close().await.unwrap();
}

// Acceptance: a read-only transaction retains its snapshot through another
// commit; concurrent writers see their own values and the loser returns the
// engine's typed conflict without retrying or publishing its other table.
async fn snapshots_and_conflicts(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("todos");
    let other = table("other");
    let original = fields(&[("version", Value::from_int(0))]);
    let mut seed = db.begin().await.unwrap();
    let id = seed.insert(&todos, original.clone()).await.unwrap();
    seed.commit().await.unwrap();
    let mut events = db.subscribe();
    let mut snapshot = db.read_only().await.unwrap();
    let old = snapshot.get(&id).await.unwrap().unwrap();
    let mut winner = db.begin().await.unwrap();
    let mut loser = db.begin().await.unwrap();
    assert_eq!(winner.get(&id).await.unwrap(), Some(old.clone()));
    assert_eq!(loser.get(&id).await.unwrap(), Some(old.clone()));
    winner
        .patch(&id, fields(&[("version", Value::from_int(1))]))
        .await
        .unwrap();
    loser
        .patch(&id, fields(&[("version", Value::from_int(2))]))
        .await
        .unwrap();
    let orphan = loser.insert(&other, Object::new()).await.unwrap();
    assert_eq!(
        winner
            .get(&id)
            .await
            .unwrap()
            .unwrap()
            .fields
            .get("version"),
        Some(&Value::from_int(1))
    );
    assert_eq!(
        loser.get(&id).await.unwrap().unwrap().fields.get("version"),
        Some(&Value::from_int(2))
    );
    winner.commit().await.unwrap();
    event(&mut events, &["todos"]);
    let conflict = loser.commit().await.unwrap_err();
    assert!(conflict.is_retryable_conflict(), "{conflict:?}");
    assert!(
        matches!(&conflict, Error::Database(error) if error.query_details() == Some(&surrealdb::types::QueryError::TransactionConflict))
    );
    assert_eq!(snapshot.get(&id).await.unwrap(), Some(old.clone()));
    assert_eq!(snapshot.query(&todos).collect().await.unwrap(), vec![old]);
    snapshot.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert_eq!(
        read.get(&id).await.unwrap().unwrap().fields.get("version"),
        Some(&Value::from_int(1))
    );
    assert_eq!(read.get(&orphan).await.unwrap(), None);
    // Read-only writes are rejected and poison the call even when caught.
    assert!(matches!(read.delete(&id).await, Err(Error::ReadOnly)));
    assert!(matches!(read.commit().await, Err(Error::FailedTransaction)));
    empty(&mut events);
    let mut tx = db.begin().await.unwrap();
    tx.insert(&other, Object::new()).await.unwrap();
    tx.commit().await.unwrap();
    event(&mut events, &["other"]);
    db.close().await.unwrap();
}

// Acceptance/security: reject SQL record expressions, Unicode identifiers and
// ambiguous keys before SQL, while preserving permitted opaque numeric keys.
#[test]
fn identifiers_are_ascii_not_sql() {
    for invalid in [
        "",
        "_todos",
        "1todos",
        "todo-items",
        "tødos",
        "todos;DELETE todos",
        "todos.foo",
    ] {
        assert!(Table::new(invalid).is_err(), "{invalid:?}");
    }
    for invalid in [
        "todos",
        "todos:",
        "todos:a:b",
        "todos:1 OR true",
        "todos:⟨key⟩",
        "todos:雪",
        "todos:[1]",
        "todos:{id:1}",
        "todos:a;DELETE todos",
    ] {
        assert!(invalid.parse::<Id>().is_err(), "{invalid:?}");
    }
    for valid in ["todos:000123", "select:A_b-9", "T_1:0"] {
        assert_eq!(valid.parse::<Id>().unwrap().to_string(), valid);
    }
    assert!(!Error::FailedTransaction.is_retryable_conflict());
    assert!(!Error::ReadOnly.is_retryable_conflict());
}

// Acceptance: awaited close releases the real disk engine, and a fresh owner
// sees committed envelope/metadata but neither rolled-back inserts nor deletes.
#[test]
fn disk_reopen_preserves_only_committed_state() {
    run(disk_reopen);
}

async fn disk_reopen() {
    let fixture = Fixture::new(true);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let todos = table("todos");
    let mut tx = db.begin().await.unwrap();
    let id = tx
        .insert(
            &todos,
            fields(&[("id", text("business")), ("data", text("payload"))]),
        )
        .await
        .unwrap();
    let deleted = tx.insert(&todos, Object::new()).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.patch(&id, fields(&[("saved", Value::Bool(true))]))
        .await
        .unwrap();
    tx.delete(&deleted).await.unwrap();
    let expected = tx.get(&id).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.delete(&id).await.unwrap();
    let rolled_back = tx.insert(&todos, Object::new()).await.unwrap();
    tx.rollback().await.unwrap();
    db.close().await.unwrap();
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let mut tx = db.read_only().await.unwrap();
    assert_eq!(tx.get(&id).await.unwrap(), Some(expected.clone()));
    assert_eq!(tx.get(&deleted).await.unwrap(), None);
    assert_eq!(tx.get(&rolled_back).await.unwrap(), None);
    assert_eq!(tx.query(&todos).collect().await.unwrap(), vec![expected]);
    tx.commit().await.unwrap();
    db.close().await.unwrap();
}
