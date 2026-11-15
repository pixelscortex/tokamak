//! TKM5 acceptance through the real SDK bundle, QuickJS and public embedded DB.
//! Engine instrumentation pauses before real JS execution or after retirement;
//! it never substitutes results, operations, conflicts, change events or storage.

use engine::{Bundle, Engine, Json, Limits, OpRegistry, Pool, PoolConfig, QuickJsEngine};
use serde_json::json;
use server::{
    Error, Event, Server, Session,
    data::{DataSpace, Database, Id, Object, Storage, Table, Value},
};
use std::{
    collections::VecDeque,
    future::Future,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::oneshot;

#[path = "support/sdk.rs"]
mod sdk;
use sdk::bundle;

fn run(f: impl Future<Output = ()>) {
    sdk::run(f, 90);
}

struct Disk(PathBuf);

impl Disk {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/tkm5-databases");
        std::fs::create_dir_all(&parent).unwrap();
        let path = parent.join(format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn storage(&self) -> Storage {
        Storage::Disk(self.0.join("db"))
    }
}

impl Drop for Disk {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Pause {
    name: String,
    before: bool,
    arrived: oneshot::Sender<Result<Json, String>>,
    resume: oneshot::Receiver<()>,
}

#[derive(Clone, Default)]
struct Probe {
    calls: Arc<Mutex<Vec<String>>>,
    pauses: Arc<Mutex<VecDeque<Pause>>>,
}

impl Probe {
    fn pause(&self, name: &str) -> (oneshot::Receiver<Result<Json, String>>, oneshot::Sender<()>) {
        self.pause_at(name, false)
    }

    fn pause_at(
        &self,
        name: &str,
        before: bool,
    ) -> (oneshot::Receiver<Result<Json, String>>, oneshot::Sender<()>) {
        let (arrived, wait) = oneshot::channel();
        let (resume, release) = oneshot::channel();
        self.pauses.lock().unwrap().push_back(Pause {
            name: format!("probe:{name}"),
            before,
            arrived,
            resume: release,
        });
        (wait, resume)
    }

    async fn checkpoint(&self, name: &str, before: bool, result: Result<Json, String>) {
        let pause = {
            let mut pauses = self.pauses.lock().unwrap();
            if pauses
                .front()
                .is_some_and(|p| p.name == name && p.before == before)
            {
                pauses.pop_front()
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            let _ = pause.arrived.send(result);
            tokio::time::timeout(Duration::from_secs(60), pause.resume)
                .await
                .expect("test did not release engine barrier")
                .unwrap();
        }
    }

    fn count(&self, name: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|n| **n == format!("probe:{name}"))
            .count()
    }

    fn pool(&self) -> Arc<Pool> {
        let probe = self.clone();
        Arc::new(
            Pool::with_engine(
                PoolConfig {
                    workers: 2,
                    queue_capacity: 32,
                    limits: Limits {
                        call_timeout: Duration::from_secs(2),
                        ..Limits::default()
                    },
                },
                move || {
                    Ok(Observed {
                        engine: QuickJsEngine::new(Limits {
                            call_timeout: Duration::from_secs(2),
                            ..Limits::default()
                        })?,
                        probe: probe.clone(),
                    })
                },
            )
            .unwrap(),
        )
    }
}

struct Observed {
    engine: QuickJsEngine,
    probe: Probe,
}

impl Engine for Observed {
    async fn invoke(
        &mut self,
        bundle: &Bundle,
        export: &str,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<Json, engine::Error> {
        let name = args["name"].as_str().unwrap_or(export).to_owned();
        self.probe.calls.lock().unwrap().push(name.clone());
        self.probe.checkpoint(&name, true, Ok(Json::Null)).await;
        let result = self.engine.invoke(bundle, export, args, ops).await;
        self.probe
            .checkpoint(&name, false, result.clone().map_err(|e| e.to_string()))
            .await;
        result
    }
}

#[test]
fn equality_dependencies_skip_other_threads_and_track_moves_deletes_and_empty_reads() {
    run(async {
        let db = Database::open(Storage::Memory).await.unwrap();
        let probe = Probe::default();
        let server = Server::load(db, probe.pool(), bundle()).await.unwrap();
        let mut reader = server.connect().await.unwrap();
        let mut writer = server.connect().await.unwrap();
        for (id, thread) in [(1, "A"), (2, "B")] {
            reader
                .subscribe(
                    id,
                    "probe:filtered",
                    json!({
                        "field":"thread","value":thread,"descending":false,"limit":10
                    }),
                )
                .unwrap();
            assert_eq!(update(&mut reader, id).await, json!([]));
        }
        assert_eq!(probe.count("filtered"), 2);
        let id = call(
            &mut writer,
            10,
            "insert",
            json!({"table":"items","value":{"thread":"A"}}),
        )
        .await;
        assert_eq!(
            probe.count("filtered"),
            3,
            "B must not execute for A's insert"
        );
        assert_eq!(update(&mut reader, 1).await.as_array().unwrap().len(), 1);
        call(
            &mut writer,
            11,
            "patch",
            json!({"id":id,"value":{"thread":"B"}}),
        )
        .await;
        assert_eq!(
            probe.count("filtered"),
            5,
            "a move affects both old and new keys"
        );
        assert_eq!(update(&mut reader, 1).await, json!([]));
        assert_eq!(update(&mut reader, 2).await.as_array().unwrap().len(), 1);
        call(
            &mut writer,
            12,
            "insert",
            json!({"table":"items","value":{"thread":"C"}}),
        )
        .await;
        assert_eq!(
            probe.count("filtered"),
            5,
            "neither A nor B should execute for C"
        );
        call(&mut writer, 13, "remove", json!({"id":id})).await;
        assert_eq!(probe.count("filtered"), 6);
        assert_eq!(update(&mut reader, 2).await, json!([]));
        writer
            .call(14, "probe:rollback", json!({"caught":false}))
            .unwrap();
        assert!(response(&mut writer, 14).await.is_err());
        assert_eq!(
            probe.count("filtered"),
            6,
            "rolled-back writes cannot invalidate"
        );
        call(
            &mut writer,
            15,
            "insert",
            json!({"table":"items","value":{
                "thread":"C","body":"x".repeat(40000)
            }}),
        )
        .await;
        assert_eq!(
            probe.count("filtered"),
            8,
            "oversized footprints safely fall back to whole table"
        );
        drop(reader);
        drop(writer);
        server.close().await.unwrap();
    });
}

#[test]
fn plugin_spaces_are_collision_free_and_caught_cross_space_access_rolls_back() {
    run(async {
        let db = Database::open(Storage::Memory).await.unwrap();
        let a = DataSpace::plugin("acme.notes").unwrap();
        let b = DataSpace::plugin("acme_notes").unwrap();
        let items = Table::new("items").unwrap();
        assert_ne!(a.table(&items).unwrap(), b.table(&items).unwrap());
        let mut seed = db.begin().await.unwrap();
        let foreign = seed
            .insert(&b.table(&items).unwrap(), Object::new())
            .await
            .unwrap();
        seed.commit().await.unwrap();
        let foreign = b.present_id(&foreign).unwrap();
        assert!(matches!(
            a.id(&foreign),
            Err(server::data::Error::AccessDenied)
        ));
        let probe = Probe::default();
        let server = Server::load_in_space(db, probe.pool(), bundle(), a)
            .await
            .unwrap();
        let mut session = server.connect().await.unwrap();
        let id = call(
            &mut session,
            1,
            "insert",
            json!({"table":"items","value":{"text":"private"}}),
        )
        .await;
        assert!(id.as_str().unwrap().starts_with("acme.notes/items:"));
        assert_eq!(
            call(&mut session, 2, "get", json!({"id":id})).await["_id"],
            id
        );
        session.call(3, "probe:get", json!({"id":foreign})).unwrap();
        assert!(
            response(&mut session, 3)
                .await
                .unwrap_err()
                .contains("does not own")
        );
        session
            .call(4, "probe:caughtForeign", json!({"id":foreign}))
            .unwrap();
        assert!(
            response(&mut session, 4)
                .await
                .unwrap_err()
                .contains("does not own")
        );
        let rows = call(&mut session, 5, "list", json!({"table":"items"})).await;
        assert_eq!(
            rows.as_array().unwrap().len(),
            1,
            "denied operation poisons the entire mutation"
        );
        let physical = DataSpace::plugin("acme_notes")
            .unwrap()
            .table(&items)
            .unwrap();
        assert_eq!(
            call(&mut session, 6, "list", json!({"table":physical.as_str()})).await,
            json!([])
        );
        drop(session);
        server.close().await.unwrap();
    });
}

async fn next(session: &mut Session) -> Event {
    session.recv().await.unwrap().expect("session closed early")
}

async fn response(session: &mut Session, id: u64) -> Result<Json, String> {
    match next(session).await {
        Event::Response { id: actual, result } => {
            assert_eq!(actual, id);
            result
        }
        event => panic!("expected response {id}, got {event:?}"),
    }
}

async fn update(session: &mut Session, id: u64) -> Json {
    match next(session).await {
        Event::Subscription { id: actual, result } => {
            assert_eq!(actual, id);
            result.unwrap()
        }
        event => panic!("expected update {id}, got {event:?}"),
    }
}

async fn call(session: &mut Session, id: u64, name: &str, args: Json) -> Json {
    session.call(id, format!("probe:{name}"), args).unwrap();
    response(session, id).await.unwrap()
}

async fn insert(session: &mut Session, id: u64, table: &str, value: Json) -> Json {
    call(session, id, "insert", json!({"table":table,"value":value})).await
}

fn fields(value: i64) -> Object {
    let mut o = Object::new();
    o.insert("value", Value::from_int(value));
    o
}

fn table(name: &str) -> Table {
    Table::new(name).unwrap()
}

// Purpose: startup metadata and actual registered SDK handlers agree; multiple
// awaited writes roll back on both uncaught JS failure and caught DB failure.
// Disk reopen proves persistence/lock release rather than just an in-memory view.
#[test]
fn startup_atomicity_and_disk_reopen() {
    run(async {
        for disk in [false, true] {
            let directory = disk.then(Disk::new);
            let storage = directory.as_ref().map_or(Storage::Memory, Disk::storage);
            let probe = Probe::default();
            let server = Server::load(
                Database::open(storage.clone()).await.unwrap(),
                probe.pool(),
                bundle(),
            )
            .await
            .unwrap();
            assert_eq!(
                probe.count("list"),
                0,
                "startup must inspect, not execute handlers"
            );
            assert_eq!(
                server.descriptor()["schema"]["tables"]["items"]["description"]["fields"]["value"]
                    ["kind"],
                "any"
            );
            assert!(
                server
                    .functions()
                    .iter()
                    .any(|f| f["name"] == "probe:insert"
                        && f["kind"] == "mutation"
                        && f["args"]["fields"]["table"]["kind"] == "string")
            );
            let mut s = server.connect().await.unwrap();
            assert_eq!(
                call(&mut s, 1, "readonly", json!({})).await,
                json!({"methods":["get","query"],"canWrite":false})
            );
            for caught in [false, true] {
                s.call(2, "probe:rollback", json!({"caught":caught}))
                    .unwrap();
                let error = response(&mut s, 2).await.unwrap_err();
                assert!(!error.is_empty());
                assert_eq!(
                    call(&mut s, 3, "list", json!({"table":"items"})).await,
                    json!([])
                );
            }
            let id = insert(&mut s, 4, "items", json!({"value":"persisted"})).await;
            let before = call(&mut s, 5, "get", json!({"id":id})).await;
            assert_eq!(before["value"], "persisted");
            server.close().await.unwrap();
            assert!(s.recv().await.unwrap().is_none());
            if disk {
                let reopened = Server::load(
                    Database::open(storage).await.unwrap(),
                    probe.pool(),
                    bundle(),
                )
                .await
                .unwrap();
                let mut s = reopened.connect().await.unwrap();
                assert_eq!(call(&mut s, 6, "get", json!({"id":id})).await, before);
                reopened.close().await.unwrap();
            }
        }
    });
}

// Purpose: adapter equality is JSON structural/numeric equality, not native SQL
// equality or dotted-path interpretation; filtering precedes limits and order.
#[test]
fn sdk_json_filter_order_and_document_metadata() {
    run(async {
        let server = Server::load(
            Database::open(Storage::Memory).await.unwrap(),
            Probe::default().pool(),
            bundle(),
        )
        .await
        .unwrap();
        let mut s = server.connect().await.unwrap();
        let complex = json!({"nested":[1.0,null,{"b":2,"a":true}]});
        let a = insert(
            &mut s,
            1,
            "items",
            json!({"a.b":complex,"odd key; SELECT * FROM items":null,"value":"first"}),
        )
        .await;
        let b = insert(
            &mut s,
            2,
            "items",
            json!({"a.b":{"nested":[1,null,{"a":true,"b":2.0}]},"value":"second"}),
        )
        .await;
        insert(
            &mut s,
            3,
            "items",
            json!({"a":{"b":complex},"value":"not a dotted path"}),
        )
        .await;
        let args = json!({"field":"a.b","value":complex,"descending":false,"limit":10});
        let rows = call(&mut s, 4, "filtered", args.clone()).await;
        assert_eq!(rows.as_array().unwrap().len(), 2);
        let mut expected = vec![a.clone(), b.clone()];
        // Creation time may tie; identity is the documented deterministic tiebreak.
        if rows[0]["_creationTime"] == rows[1]["_creationTime"] {
            expected.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        }
        assert_eq!(
            rows.as_array()
                .unwrap()
                .iter()
                .map(|r| r["_id"].clone())
                .collect::<Vec<_>>(),
            expected
        );
        let mut descending = args.clone();
        descending["descending"] = json!(true);
        descending["limit"] = json!(1);
        assert_eq!(
            call(&mut s, 5, "filtered", descending).await,
            json!([rows[1]])
        );
        let mut zero = args;
        zero["limit"] = json!(0);
        assert_eq!(call(&mut s, 6, "filtered", zero).await, json!([]));
        let nulls = call(&mut s, 7, "filtered", json!({"field":"odd key; SELECT * FROM items","value":null,"descending":false,"limit":10})).await;
        assert_eq!(
            nulls.as_array().unwrap().len(),
            1,
            "missing is not null; field names are not SQL"
        );
        let before = call(&mut s, 8, "get", json!({"id":a})).await;
        call(&mut s, 9, "patch", json!({"id":a,"value":{"new":7}})).await;
        let patched = call(&mut s, 10, "get", json!({"id":a})).await;
        assert_eq!(patched["a.b"], rows[0]["a.b"]);
        call(
            &mut s,
            11,
            "replace",
            json!({"id":a,"value":{"replacement":true}}),
        )
        .await;
        assert_eq!(
            call(&mut s, 12, "get", json!({"id":a})).await,
            json!({"_id":a,"_creationTime":before["_creationTime"],"replacement":true})
        );
        call(&mut s, 13, "remove", json!({"id":a})).await;
        assert_eq!(call(&mut s, 14, "get", json!({"id":a})).await, Json::Null);
        assert_eq!(
            call(&mut s, 15, "remove", json!({"id":a})).await,
            Json::Null
        );
        server.close().await.unwrap();
    });
}

// Purpose: empty/table-level dependencies, unrelated-table silence, same-result
// suppression and writer update-before-response share ONE ordered session stream.
// Invocation counts prove silence is not merely deduplicating an unnecessary run.
#[test]
fn subscription_invalidation_dedup_and_writer_barrier() {
    run(async {
        let probe = Probe::default();
        let server = Server::load(
            Database::open(Storage::Memory).await.unwrap(),
            probe.pool(),
            bundle(),
        )
        .await
        .unwrap();
        let mut s = server.connect().await.unwrap();
        s.subscribe(100, "probe:list", json!({"table":"items"}))
            .unwrap();
        s.subscribe(101, "probe:count", json!({})).unwrap();
        s.subscribe(102, "probe:get", json!({"id":"items:missing"}))
            .unwrap();
        assert_eq!(update(&mut s, 100).await, json!([]));
        assert_eq!(update(&mut s, 101).await, json!(0));
        assert_eq!(update(&mut s, 102).await, Json::Null);
        insert(&mut s, 1, "unrelated", json!({"value":0})).await;
        assert_eq!(probe.count("list"), 1);
        assert_eq!(probe.count("count"), 1);
        assert_eq!(probe.count("get"), 1);
        s.call(
            2,
            "probe:insert",
            json!({"table":"items","value":{"value":1}}),
        )
        .unwrap();
        let rows = update(&mut s, 100).await;
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(update(&mut s, 101).await, json!(1));
        let id = response(&mut s, 2).await.unwrap();
        assert_eq!(rows[0]["_id"], id);
        // Missing gets retain a dependency on their exact ID, not every row.
        assert_eq!(probe.count("get"), 1);
        // Same table, different row/field: rerun count, but don't resend its 1.
        s.call(3, "probe:patch", json!({"id":id,"value":{"value":2}}))
            .unwrap();
        assert_eq!(update(&mut s, 100).await[0]["value"], 2);
        response(&mut s, 3).await.unwrap();
        assert_eq!(probe.count("count"), 3);
        // A no-op is not a changed-table event and sends no subscription result.
        call(&mut s, 4, "patch", json!({"id":id,"value":{"value":2}})).await;
        assert_eq!(probe.count("count"), 3);
        s.subscribe(100, "probe:count", json!({})).unwrap();
        assert!(
            response(&mut s, 100)
                .await
                .unwrap_err()
                .contains("already in use")
        );
        s.unsubscribe(100).unwrap();
        assert_eq!(next(&mut s).await, Event::Unsubscribed { id: 100 });
        s.call(5, "probe:remove", json!({"id":id})).unwrap();
        assert_eq!(update(&mut s, 101).await, json!(0));
        response(&mut s, 5).await.unwrap();
        s.subscribe(200, "probe:insert", json!({"table":"items","value":{}}))
            .unwrap();
        assert!(
            response(&mut s, 200)
                .await
                .unwrap_err()
                .contains("registered query")
        );
        server.close().await.unwrap();
    });
}

// Purpose: admitted commands remain linearized if a transport cancels its recv
// future; queue overflow refuses admission and slow output terminates explicitly.
#[test]
fn bounded_admission_slow_consumer_and_cancelled_receiver() {
    run(async {
        let probe = Probe::default();
        let server = Server::load(
            Database::open(Storage::Memory).await.unwrap(),
            probe.pool(),
            bundle(),
        )
        .await
        .unwrap();
        let mut s = server.connect().await.unwrap();
        let (arrived, resume) = probe.pause("insert");
        s.sender()
            .call(
                1,
                "probe:insert",
                json!({"table":"items","value":{"value":"accepted"}}),
            )
            .unwrap();
        arrived.await.unwrap().unwrap();
        // Poll exactly once to establish that reception really began, then cancel.
        let mut receive = Box::pin(s.recv());
        std::future::poll_fn(|cx| {
            assert!(receive.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        drop(receive);
        let sender = s.sender();
        for id in 2..66 {
            sender.call(id, "missing", json!({})).unwrap();
        }
        assert_eq!(
            sender.call(66, "missing", json!({})),
            Err(Error::Overloaded)
        );
        resume.send(()).unwrap();
        // Connect is an actor barrier after all already-admitted commands. If the
        // queue is still full, yield until admission is possible (no timing guess).
        let mut healthy = loop {
            match server.connect().await {
                Ok(s) => break s,
                Err(Error::Overloaded) => tokio::task::yield_now().await,
                Err(e) => panic!("{e}"),
            }
        };
        assert_eq!(call(&mut healthy, 1, "count", json!({})).await, json!(1));
        // Drain buffered events, then require explicit SlowConsumer, not silent EOF.
        let mut delivered = 0;
        loop {
            match s.recv().await {
                Ok(Some(event)) => {
                    if delivered == 0 {
                        assert!(
                            matches!(
                                event,
                                Event::Response {
                                    id: 1,
                                    result: Ok(_)
                                }
                            ),
                            "the accepted write's response must remain first"
                        );
                    }
                    delivered += 1;
                }
                Err(Error::SlowConsumer) => break,
                other => panic!("unexpected slow stream: {other:?}"),
            }
        }
        assert!(delivered > 0 && delivered <= 32);
        assert_eq!(
            sender.call(99, "missing", json!({})),
            Err(Error::SlowConsumer)
        );
        server.close().await.unwrap();
    });
}

// Purpose: a real native commit races initial query retirement, and another races
// the installation of a NEW dynamic readset. The stale result must never publish.
// Pausing one query while queuing a write also proves per-subscription single flight.
#[test]
fn initial_and_new_readset_races_are_not_lost() {
    run(async {
        let db = Database::open(Storage::Memory).await.unwrap();
        let mut initial_writer = db.begin().await.unwrap();
        let mut selection_writer = db.begin().await.unwrap();
        let mut right_writer = db.begin().await.unwrap();
        let probe = Probe::default();
        let server = Server::load(db, probe.pool(), bundle()).await.unwrap();
        let mut s = server.connect().await.unwrap();
        let (arrived, resume) = probe.pause("selected");
        s.subscribe(100, "probe:selected", json!({})).unwrap();
        assert_eq!(arrived.await.unwrap().unwrap(), json!([]));
        initial_writer
            .insert(&table("left"), fields(1))
            .await
            .unwrap();
        initial_writer.commit().await.unwrap();
        s.call(1, "probe:count", json!({})).unwrap();
        assert_eq!(
            probe.count("selected"),
            1,
            "second run cannot overlap the paused initial run"
        );
        resume.send(()).unwrap();
        assert_eq!(update(&mut s, 100).await[0]["value"], 1);
        response(&mut s, 1).await.unwrap();
        let (arrived, resume) = probe.pause("selected");
        let mut choose_right = Object::new();
        choose_right.insert("table", Value::String("right".into()));
        selection_writer
            .insert(&table("selection"), choose_right)
            .await
            .unwrap();
        selection_writer.commit().await.unwrap();
        assert_eq!(arrived.await.unwrap().unwrap(), json!([]));
        right_writer
            .insert(&table("right"), fields(2))
            .await
            .unwrap();
        right_writer.commit().await.unwrap();
        resume.send(()).unwrap();
        assert_eq!(update(&mut s, 100).await[0]["value"], 2);
        // Old dependency is removed; committing the service mutation is a barrier.
        let runs = probe.count("selected");
        insert(&mut s, 2, "left", json!({"value":3})).await;
        assert_eq!(probe.count("selected"), runs);
        server.close().await.unwrap();
    });
}

// Purpose: overflowing the REAL broadcast channel during a paused initial query
// requires full invalidation, including a changed read table whose event was lost.
#[test]
fn lag_forces_full_invalidation() {
    run(async {
        let db = Database::open(Storage::Memory).await.unwrap();
        // Establish both tables before taking concurrent snapshots. Concurrent
        // first-ever table creation legitimately conflicts in the real engine.
        let mut seed = db.begin().await.unwrap();
        seed.insert(&table("items"), fields(-1)).await.unwrap();
        seed.insert(&table("noise"), fields(-1)).await.unwrap();
        seed.commit().await.unwrap();
        let mut writers = Vec::new();
        // Retained public transactions are the only external writers once Server
        // owns Database. Distinct inserted IDs avoid artificial write conflicts.
        for _ in 0..258 {
            writers.push(db.begin().await.unwrap());
        }
        let probe = Probe::default();
        let server = Server::load(db, probe.pool(), bundle()).await.unwrap();
        let mut s = server.connect().await.unwrap();
        let (arrived, resume) = probe.pause("count");
        s.subscribe(100, "probe:count", json!({})).unwrap();
        assert_eq!(arrived.await.unwrap().unwrap(), json!(1));
        for (i, mut tx) in writers.into_iter().enumerate() {
            tx.insert(
                &table(if i == 0 { "items" } else { "noise" }),
                fields(i as i64),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
        }
        resume.send(()).unwrap();
        assert_eq!(
            update(&mut s, 100).await,
            json!(2),
            "lost items event requires a fresh snapshot"
        );
        assert!(probe.count("count") >= 2);
        server.close().await.unwrap();
    });
}

// Purpose: a query's snapshot is fixed before execution, not reopened by each
// host operation. A real native writer commits AFTER the host opens the query
// transaction but BEFORE QuickJS enters the handler; this call still sees old data.
#[test]
fn query_reads_the_call_owned_snapshot() {
    run(async {
        let db = Database::open(Storage::Memory).await.unwrap();
        let mut seed = db.begin().await.unwrap();
        let id = seed.insert(&table("items"), fields(1)).await.unwrap();
        seed.commit().await.unwrap();
        let mut writer = db.begin().await.unwrap();
        writer.patch(&id, fields(2)).await.unwrap();
        let probe = Probe::default();
        let server = Server::load(db, probe.pool(), bundle()).await.unwrap();
        let mut s = server.connect().await.unwrap();
        let (arrived, resume) = probe.pause_at("get", true);
        s.call(1, "probe:get", json!({"id":id.to_string()}))
            .unwrap();
        arrived.await.unwrap().unwrap();
        writer.commit().await.unwrap();
        resume.send(()).unwrap();
        assert_eq!(response(&mut s, 1).await.unwrap()["value"], 1);
        assert_eq!(
            call(&mut s, 2, "get", json!({"id":id.to_string()})).await["value"],
            2
        );
        server.close().await.unwrap();
    });
}

// Purpose: definite native conflicts replay the WHOLE real handler with a fresh
// transaction/world, and exhaustion is bounded and clear. No loser audit/write
// may commit. Run both backends; do not synthesize a conflict error in a mock.
#[test]
fn whole_handler_conflict_retry_and_exhaustion() {
    run(async {
        for disk in [false, true] {
            for conflicts in [1, 3] {
                let directory = disk.then(Disk::new);
                let db = Database::open(directory.as_ref().map_or(Storage::Memory, Disk::storage))
                    .await
                    .unwrap();
                let mut seed = db.begin().await.unwrap();
                let mut ids = Vec::<Id>::new();
                for _ in 0..3 {
                    ids.push(seed.insert(&table("items"), fields(0)).await.unwrap());
                }
                seed.commit().await.unwrap();
                let mut winners = Vec::new();
                for i in 0..conflicts {
                    let mut tx = db.begin().await.unwrap();
                    tx.patch(&ids[i], fields(10)).await.unwrap();
                    winners.push(tx);
                }
                let probe = Probe::default();
                let mut barriers = VecDeque::new();
                for _ in 0..conflicts {
                    barriers.push_back(probe.pause("increment"));
                }
                let server = Server::load(db, probe.pool(), bundle()).await.unwrap();
                let mut s = server.connect().await.unwrap();
                s.call(
                    1,
                    "probe:increment",
                    json!({"ids":ids.iter().map(ToString::to_string).collect::<Vec<_>>()}),
                )
                .unwrap();
                for (i, winner) in winners.into_iter().enumerate() {
                    let (arrived, resume) = barriers.pop_front().unwrap();
                    let values = arrived.await.unwrap().unwrap();
                    for j in 0..3 {
                        assert_eq!(
                            values[j],
                            if j < i { 11 } else { 1 },
                            "whole-handler snapshot must advance on replay"
                        );
                    }
                    winner.commit().await.unwrap();
                    resume.send(()).unwrap();
                }
                let result = response(&mut s, 1).await;
                if conflicts == 1 {
                    assert_eq!(result.unwrap(), json!([11, 1, 1]));
                    assert_eq!(probe.count("increment"), 2);
                    assert_eq!(
                        call(&mut s, 2, "list", json!({"table":"audit"}))
                            .await
                            .as_array()
                            .unwrap()
                            .len(),
                        1
                    );
                } else {
                    assert!(
                        result
                            .unwrap_err()
                            .contains("conflict retry limit exceeded")
                    );
                    assert_eq!(probe.count("increment"), 3);
                    assert_eq!(
                        call(&mut s, 2, "list", json!({"table":"audit"})).await,
                        json!([])
                    );
                    for id in &ids {
                        assert_eq!(
                            call(&mut s, 3, "get", json!({"id":id.to_string()})).await["value"],
                            10
                        );
                    }
                }
                server.close().await.unwrap();
            }
        }
    });
}

// Purpose: timeout after an awaited write rolls back, and unawaited operations
// cannot escape retirement and later mutate storage or publish phantom events.
#[test]
fn timeout_and_abandoned_host_operations_do_not_leak_writes() {
    run(async {
        let db = Database::open(Storage::Memory).await.unwrap();
        let mut changes = db.subscribe();
        let server = Server::load(db, Probe::default().pool(), bundle())
            .await
            .unwrap();
        let mut s = server.connect().await.unwrap();
        s.call(1, "probe:timeout", json!({})).unwrap();
        assert!(
            response(&mut s, 1)
                .await
                .unwrap_err()
                .contains("wall-clock budget")
        );
        assert_eq!(call(&mut s, 2, "count", json!({})).await, json!(0));
        s.call(3, "probe:abandoned", json!({})).unwrap();
        // Await discipline is not itself a host contract: a fast operation may
        // finish before retirement. What must never happen is committing an
        // unreported write, or a pending operation escaping into a later call.
        let outcome = response(&mut s, 3).await;
        let count = call(&mut s, 4, "count", json!({})).await;
        if count == json!(1) {
            assert!(outcome.is_ok(), "a failed call cannot commit an operation");
            assert_eq!(changes.try_recv().unwrap().tables, vec![table("items")]);
        } else {
            assert_eq!(count, json!(0));
        }
        assert_eq!(
            changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        );
        // An unrelated committed handler followed by another snapshot is a
        // lifecycle barrier, not a sleep intended to catch a detached callback.
        insert(&mut s, 5, "unrelated", json!({"value":1})).await;
        assert_eq!(changes.try_recv().unwrap().tables, vec![table("unrelated")]);
        assert_eq!(call(&mut s, 6, "count", json!({})).await, count);
        assert_eq!(
            changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        );
        server.close().await.unwrap();
    });
}
