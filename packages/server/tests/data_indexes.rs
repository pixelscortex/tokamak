//! Acceptance tests for the direct-storage data layer's named indexes, and for
//! the parts of the document/change contract the storage rewrite re-implemented
//! but `tests/data.rs` does not check (value fidelity, record footprints and
//! their overflow bounds, persistence of index definitions).
//!
//! Every expectation is computed from the inserted rows by an independent Rust
//! filter, never from another index read, so a wrong index cannot vouch for
//! itself. Each backend-sensitive scenario runs on the real memory engine and
//! the real SurrealKV disk engine.

use serde_json::json;
use server::data::{
    ChangeEvent, Database, Document, Error, Id, Object, Order, Storage, Table, Value,
};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use surrealdb_types::Number;
use tokio::sync::broadcast::{Receiver, error::TryRecvError};

// ---------------------------------------------------------------------------
// Fixtures (same shape as tests/data.rs: test-owned directory, awaited close
// before cleanup, an 8 MiB stack for debug builds of the embedded engines).
// ---------------------------------------------------------------------------

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
        let parent =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/tkm83-index-tests");
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
            // Best effort while panicking: a failed assertion may leave the
            // engine open, and a second panic would hide the real failure.
            if std::thread::panicking() {
                let _ = std::fs::remove_dir_all(directory);
            } else {
                std::fs::remove_dir_all(directory).expect("remove this test's owned directory");
            }
        }
    }
}

fn run<F: std::future::Future<Output = ()>>(scenario: impl FnOnce() -> F + Send + 'static) {
    fn execute<F: std::future::Future<Output = ()>>(scenario: impl FnOnce() -> F) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(scenario());
    }
    let result = std::thread::Builder::new()
        .name("tkm83-index-test".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(move || execute(scenario))
        .unwrap()
        .join();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
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

fn int(value: i64) -> Value {
    Value::from_int(value)
}

fn float(value: f64) -> Value {
    Value::Number(Number::Float(value))
}

fn table(name: &str) -> Table {
    Table::new(name).unwrap()
}

fn keys(rows: &[Document]) -> Vec<String> {
    rows.iter().map(|row| row.id.to_string()).collect()
}

fn sorted_keys(rows: &[Document]) -> Vec<String> {
    let mut keys = keys(rows);
    keys.sort();
    keys
}

/// A committed write is the barrier proving no earlier transaction queued an
/// event: exactly the barrier's event must be next, and nothing after it.
async fn barrier(db: &Database, events: &mut Receiver<ChangeEvent>) {
    let mut tx = db.begin().await.unwrap();
    tx.insert(&table("barrier"), Object::new()).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(events.try_recv().unwrap().tables, vec![table("barrier")]);
    assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
}

// ---------------------------------------------------------------------------
// Ranges: equality prefix + one bounded field, both directions, with limits.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum N {
    I(i64),
    F(f64),
}
impl N {
    fn value(self) -> Value {
        match self {
            N::I(n) => int(n),
            N::F(n) => float(n),
        }
    }
    fn num(self) -> f64 {
        match self {
            N::I(n) => n as f64,
            N::F(n) => n,
        }
    }
}

// 2 < 10 < 100 numerically but "10" < "100" < "2" as strings; negatives and
// fractions straddle zero; 10 appears twice so ties must break by record ID.
const VALUES: [N; 10] = [
    N::I(100),
    N::I(2),
    N::I(10),
    N::I(10),
    N::I(-1),
    N::F(-2.5),
    N::I(0),
    N::F(1.5),
    N::F(0.5),
    N::F(-0.75),
];

#[derive(Clone, Copy, Debug)]
struct Range {
    lower: Option<(bool, N)>, // (inclusive, bound)
    upper: Option<(bool, N)>,
}
impl Range {
    fn admits(&self, value: f64) -> bool {
        self.lower.is_none_or(|(inclusive, bound)| {
            if inclusive {
                value >= bound.num()
            } else {
                value > bound.num()
            }
        }) && self.upper.is_none_or(|(inclusive, bound)| {
            if inclusive {
                value <= bound.num()
            } else {
                value < bound.num()
            }
        })
    }
}
const fn lo(inclusive: bool, bound: N) -> Option<(bool, N)> {
    Some((inclusive, bound))
}

backends!(memory_index_ranges, disk_index_ranges, index_ranges);

// Contract 5: `with_index` + leading `eq` + one range on the next field returns
// exactly the matching rows in (value, ID) order, both directions, honouring
// limit. Guards numeric-vs-string ordering, int/float bounds, the equality
// prefix boundary ("a" must not match "ab"), ties, and descending limits that
// must start from the top of the range rather than the top of the prefix.
async fn index_ranges(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let readings = table("readings");
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&readings, "by_sensor_value", &["sensor", "value"], false)
        .await
        .unwrap();
    tx.define_index(&readings, "by_value", &["value"], false)
        .await
        .unwrap();
    let mut numeric: Vec<(String, f64, Id)> = Vec::new();
    for sensor in ["a", "ab", "b"] {
        for value in VALUES {
            let id = tx
                .insert(
                    &readings,
                    fields(&[("sensor", text(sensor)), ("value", value.value())]),
                )
                .await
                .unwrap();
            numeric.push((sensor.into(), value.num(), id));
        }
    }
    // Non-numeric rows of sensor "z" that no numeric two-sided range may
    // return under any value ordering (null < numbers < strings).
    for extra in [Some(text("5")), Some(Value::Null), None, Some(text("10"))] {
        let mut row = fields(&[("sensor", text("z"))]);
        if let Some(value) = extra {
            row.insert("value", value);
        }
        tx.insert(&readings, row).await.unwrap();
    }
    let five = tx
        .insert(
            &readings,
            fields(&[("sensor", text("z")), ("value", int(5))]),
        )
        .await
        .unwrap();
    numeric.push(("z".into(), 5.0, five.clone()));
    tx.commit().await.unwrap();

    let mut tx = db.read_only().await.unwrap();
    let mut all = std::collections::HashMap::new();
    for row in tx.query(&readings).collect().await.unwrap() {
        all.insert(row.id.to_string(), row);
    }
    let expected = |sensor: Option<&str>, range: Range, order: Order, limit: Option<usize>| {
        let mut rows: Vec<_> = numeric
            .iter()
            .filter(|(s, v, _)| sensor.is_none_or(|sensor| s == sensor) && range.admits(*v))
            .collect();
        rows.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.2.key().cmp(b.2.key())));
        if matches!(order, Order::Desc) {
            rows.reverse();
        }
        rows.truncate(limit.unwrap_or(usize::MAX));
        rows.into_iter()
            .map(|(_, _, id)| all[&id.to_string()].clone())
            .collect::<Vec<_>>()
    };

    let ranges = [
        Range {
            lower: lo(false, N::I(-1)),
            upper: None,
        },
        Range {
            lower: lo(true, N::I(-1)),
            upper: None,
        },
        Range {
            lower: None,
            upper: lo(false, N::I(2)),
        },
        Range {
            lower: None,
            upper: lo(true, N::I(2)),
        },
        Range {
            lower: lo(true, N::F(-2.5)),
            upper: lo(false, N::I(10)),
        },
        Range {
            lower: lo(false, N::F(1.5)),
            upper: lo(true, N::I(10)),
        },
        Range {
            lower: lo(true, N::I(2)),
            upper: lo(true, N::I(100)),
        },
        // Float bounds against integer rows: -1.0 excludes -1, 10.0 keeps both 10s.
        Range {
            lower: lo(false, N::F(-1.0)),
            upper: lo(true, N::F(10.0)),
        },
        Range {
            lower: lo(true, N::I(10)),
            upper: lo(true, N::I(10)),
        },
        Range {
            lower: lo(true, N::F(-0.8)),
            upper: lo(false, N::F(0.6)),
        },
        // Empty and contradictory ranges.
        Range {
            lower: lo(true, N::I(5)),
            upper: lo(true, N::I(5)),
        },
        Range {
            lower: lo(false, N::I(10)),
            upper: lo(false, N::I(10)),
        },
        Range {
            lower: lo(true, N::I(50)),
            upper: lo(true, N::I(3)),
        },
    ];
    for range in ranges {
        for (order, limit) in [
            (Order::Asc, None),
            (Order::Desc, None),
            (Order::Asc, Some(2)),
            (Order::Desc, Some(3)),
        ] {
            let mut query = tx
                .query(&readings)
                .with_index("by_sensor_value")
                .eq("sensor", "a");
            if let Some((inclusive, bound)) = range.lower {
                query = if inclusive {
                    query.gte("value", bound.value())
                } else {
                    query.gt("value", bound.value())
                };
            }
            if let Some((inclusive, bound)) = range.upper {
                query = if inclusive {
                    query.lte("value", bound.value())
                } else {
                    query.lt("value", bound.value())
                };
            }
            query = query.order(order);
            if let Some(limit) = limit {
                query = query.limit(limit as u32);
            }
            assert_eq!(
                keys(&query.collect().await.unwrap()),
                keys(&expected(Some("a"), range, order, limit)),
                "sensor a {range:?} {order:?} limit {limit:?}"
            );
        }
    }

    // Equality alone covers the whole prefix in value order (sensor "a" has
    // only numeric values), and `first` on a descending read is the maximum.
    let everything = Range {
        lower: None,
        upper: None,
    };
    assert_eq!(
        keys(
            &tx.query(&readings)
                .with_index("by_sensor_value")
                .eq("sensor", "a")
                .collect()
                .await
                .unwrap()
        ),
        keys(&expected(Some("a"), everything, Order::Asc, None))
    );
    assert_eq!(
        tx.query(&readings)
            .with_index("by_sensor_value")
            .eq("sensor", "b")
            .order(Order::Desc)
            .first()
            .await
            .unwrap()
            .map(|row| row.fields.get("value").cloned()),
        Some(Some(int(100)))
    );
    // A two-sided numeric range never returns null, missing or string values.
    let z = Range {
        lower: lo(true, N::I(0)),
        upper: lo(true, N::I(10)),
    };
    assert_eq!(
        keys(
            &tx.query(&readings)
                .with_index("by_sensor_value")
                .eq("sensor", "z")
                .gte("value", 0i64)
                .lte("value", 10i64)
                .collect()
                .await
                .unwrap()
        ),
        vec![five.to_string()]
    );
    // An index whose first field is the range field: no equality prefix, the
    // range spans all sensors and still excludes the non-numeric rows.
    let span = Range {
        lower: lo(true, N::I(0)),
        upper: lo(false, N::I(10)),
    };
    for order in [Order::Asc, Order::Desc] {
        assert_eq!(
            keys(
                &tx.query(&readings)
                    .with_index("by_value")
                    .gte("value", 0i64)
                    .lt("value", 10i64)
                    .order(order)
                    .collect()
                    .await
                    .unwrap()
            ),
            keys(&expected(None, span, order, None)),
            "{order:?}"
        );
    }
    assert_eq!(
        keys(
            &tx.query(&readings)
                .with_index("by_value")
                .gte("value", 0i64)
                .lte("value", 10i64)
                .order(Order::Desc)
                .take(4)
                .await
                .unwrap()
        ),
        keys(&expected(None, z, Order::Desc, Some(4)))
    );
    // Equality on the full compound key selects exactly the duplicates of 10.
    assert_eq!(
        sorted_keys(
            &tx.query(&readings)
                .with_index("by_sensor_value")
                .eq("sensor", "ab")
                .eq("value", 10i64)
                .collect()
                .await
                .unwrap()
        ),
        sorted_keys(&expected(
            Some("ab"),
            Range {
                lower: lo(true, N::I(10)),
                upper: lo(true, N::I(10))
            },
            Order::Asc,
            None
        ))
    );
    tx.commit().await.unwrap();
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Definitions and invalid index reads.
// ---------------------------------------------------------------------------

backends!(
    memory_index_definitions,
    disk_index_definitions,
    index_definitions
);

// Contract 5: identical redefinition is a no-op (even once rows exist), a
// different definition under the same name and a definition on a populated
// table are explicit errors that poison the call. Invalid index reads (unknown
// name, wrong field order, double bounds, ranges without an index) are errors
// rather than silently degrading into an unindexed or partial scan.
async fn index_definitions(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let posts = table("posts");
    let mut events = db.subscribe();

    let mut tx = db.begin().await.unwrap();
    tx.define_index(&posts, "by_author_time", &["author", "time"], false)
        .await
        .unwrap();
    // Identical repeat inside the defining transaction.
    tx.define_index(&posts, "by_author_time", &["author", "time"], false)
        .await
        .unwrap();
    // Reading a defined index on a table with no rows yet is empty, not an error.
    assert!(
        tx.query(&posts)
            .with_index("by_author_time")
            .collect()
            .await
            .unwrap()
            .is_empty()
    );
    let id = tx
        .insert(&posts, fields(&[("author", text("ann")), ("time", int(1))]))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(events.try_recv().unwrap().tables, vec![posts.clone()]);

    // Identical repeat in a later call, now that the table has rows.
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&posts, "by_author_time", &["author", "time"], false)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let conflicting: [(&str, &[&str], bool); 4] = [
        ("by_author_time", &["author"], false),
        ("by_author_time", &["time", "author"], false),
        ("by_author_time", &["author", "time"], true),
        ("by_author_time", &["author", "time", "extra"], false),
    ];
    for (name, columns, unique) in conflicting {
        let mut tx = db.begin().await.unwrap();
        tx.insert(&table("scratch"), Object::new()).await.unwrap();
        let error = tx
            .define_index(&posts, name, columns, unique)
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Invalid(_)),
            "{columns:?} {unique}: {error:?}"
        );
        assert!(!error.is_retryable_conflict());
        // Poisoned: the earlier successful insert cannot be saved.
        assert!(matches!(tx.commit().await, Err(Error::FailedTransaction)));
    }

    // A new definition on a table that already has rows is rejected with an
    // explicit backfill error; running it would leave existing rows unindexed.
    let mut tx = db.begin().await.unwrap();
    let error = tx
        .define_index(&posts, "by_time", &["time"], false)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, Error::Invalid(message) if message.contains("backfill")),
        "{error:?}"
    );
    assert!(matches!(tx.commit().await, Err(Error::FailedTransaction)));
    let mut tx = db.begin().await.unwrap();
    assert!(
        tx.query(&posts)
            .with_index("by_time")
            .collect()
            .await
            .is_err(),
        "a rejected definition must not exist afterwards"
    );
    drop(tx);

    // Malformed definitions.
    for columns in [&[][..], &["author", "author"][..], &["bad-field"][..]] {
        let mut tx = db.begin().await.unwrap();
        assert!(
            matches!(
                tx.define_index(&table("fresh"), "ix", columns, false).await,
                Err(Error::Invalid(_))
            ),
            "{columns:?}"
        );
        assert!(matches!(tx.commit().await, Err(Error::FailedTransaction)));
    }

    // Invalid reads: each is an error and poisons, even with limit zero.
    type Bad = fn(server::data::Query<'_>) -> server::data::Query<'_>;
    let bad: [(&str, Bad); 7] = [
        ("unknown index", |q| q.with_index("no_such_index")),
        ("unknown index, limit 0", |q| {
            q.with_index("no_such_index").limit(0)
        }),
        ("eq skips the leading field", |q| {
            q.with_index("by_author_time").eq("time", 1i64)
        }),
        ("range on the leading field after eq", |q| {
            q.with_index("by_author_time")
                .eq("author", "ann")
                .gt("author", "a")
        }),
        ("range skips a field", |q| {
            q.with_index("by_author_time").gt("time", 0i64)
        }),
        ("two lower bounds", |q| {
            q.with_index("by_author_time")
                .eq("author", "ann")
                .gt("time", 0i64)
                .gte("time", 1i64)
        }),
        ("range without an index", |q| q.gt("time", 0i64)),
    ];
    for (case, build) in bad {
        let mut tx = db.begin().await.unwrap();
        tx.insert(&table("scratch"), Object::new()).await.unwrap();
        assert!(build(tx.query(&posts)).collect().await.is_err(), "{case}");
        assert!(
            matches!(tx.commit().await, Err(Error::FailedTransaction)),
            "{case}"
        );
    }
    // An index name is scoped to its table.
    let mut tx = db.read_only().await.unwrap();
    assert!(
        tx.query(&table("scratch"))
            .with_index("by_author_time")
            .collect()
            .await
            .is_err()
    );
    drop(tx);

    let mut tx = db.read_only().await.unwrap();
    assert_eq!(
        keys(
            &tx.query(&posts)
                .with_index("by_author_time")
                .collect()
                .await
                .unwrap()
        ),
        vec![id.to_string()]
    );
    assert!(
        tx.query(&table("scratch"))
            .collect()
            .await
            .unwrap()
            .is_empty()
    );
    tx.commit().await.unwrap();
    barrier(&db, &mut events).await;
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Index maintenance under every document mutation.
// ---------------------------------------------------------------------------

backends!(
    memory_index_maintenance,
    disk_index_maintenance,
    index_maintenance
);

// Contract 5: after insert, patch, replace and delete, index reads reflect the
// new state with no stale and no duplicate entries. Adversarial edits: patching
// an indexed field to its current value, patching only a non-indexed field,
// changing only the second field of a compound key, replacing a document so
// its indexed field disappears, and delete + re-insert of the same key values.
// Also: the writer's own index reads see its uncommitted writes, while a
// snapshot opened before the commit keeps seeing the old index state.
async fn index_maintenance(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let tasks = table("tasks");
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&tasks, "by_status", &["status"], false)
        .await
        .unwrap();
    tx.define_index(&tasks, "by_list_rank", &["list", "rank"], false)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for (status, list, rank) in [
        ("open", "home", 1),
        ("open", "home", 2),
        ("done", "home", 3),
        ("open", "work", 1),
        ("done", "work", 2),
    ] {
        ids.push(
            tx.insert(
                &tasks,
                fields(&[
                    ("status", text(status)),
                    ("list", text(list)),
                    ("rank", int(rank)),
                    ("note", text("n")),
                ]),
            )
            .await
            .unwrap(),
        );
    }
    tx.commit().await.unwrap();

    let before = db.read_only().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    // Same indexed value: must not drop or duplicate its entry.
    tx.patch(
        &ids[0],
        fields(&[("status", text("open")), ("note", text("same status"))]),
    )
    .await
    .unwrap();
    // Non-indexed field only.
    tx.patch(&ids[1], fields(&[("note", text("edited"))]))
        .await
        .unwrap();
    // Indexed field moves between keys.
    tx.patch(&ids[2], fields(&[("status", text("open"))]))
        .await
        .unwrap();
    // Only the second field of the compound key changes: home rank 1 -> 5.
    tx.patch(&ids[0], fields(&[("rank", int(5))]))
        .await
        .unwrap();
    // Replace drops "status" entirely and moves the compound key.
    tx.replace(&ids[3], fields(&[("list", text("home")), ("rank", int(4))]))
        .await
        .unwrap();
    // Delete, then a new row with exactly the deleted row's key values.
    tx.delete(&ids[4]).await.unwrap();
    let reinserted = tx
        .insert(
            &tasks,
            fields(&[
                ("status", text("done")),
                ("list", text("work")),
                ("rank", int(2)),
            ]),
        )
        .await
        .unwrap();

    // Independent truth: an unindexed scan of the same snapshot.
    async fn check(tx: &mut server::data::Transaction, tasks: &Table) {
        let rows = tx.query(tasks).collect().await.unwrap();
        for status in ["open", "done", "missing"] {
            let expected: Vec<_> = rows
                .iter()
                .filter(|row| row.fields.get("status") == Some(&text(status)))
                .cloned()
                .collect();
            let indexed = tx
                .query(tasks)
                .with_index("by_status")
                .eq("status", status)
                .collect()
                .await
                .unwrap();
            assert_eq!(
                sorted_keys(&indexed),
                sorted_keys(&expected),
                "status {status}"
            );
            // Rows come back with their current contents, not a stale image.
            for row in &indexed {
                assert!(rows.contains(row), "stale document {row:?}");
            }
        }
        for list in ["home", "work"] {
            let mut expected: Vec<_> = rows
                .iter()
                .filter(|row| row.fields.get("list") == Some(&text(list)))
                .cloned()
                .collect();
            expected.sort_by_key(|row| match row.fields.get("rank") {
                Some(Value::Number(Number::Int(rank))) => *rank,
                other => panic!("rank {other:?}"),
            });
            let indexed = tx
                .query(tasks)
                .with_index("by_list_rank")
                .eq("list", list)
                .collect()
                .await
                .unwrap();
            assert_eq!(indexed, expected, "list {list}");
        }
        // Every row has exactly one compound entry: no leftovers from moves.
        let whole = tx
            .query(tasks)
            .with_index("by_list_rank")
            .collect()
            .await
            .unwrap();
        assert_eq!(sorted_keys(&whole), sorted_keys(&rows));
    }
    check(&mut tx, &tasks).await;
    // Spot-check the concrete expectations behind the generic check.
    assert_eq!(
        keys(
            &tx.query(&tasks)
                .with_index("by_list_rank")
                .eq("list", "home")
                .gt("rank", 3i64)
                .collect()
                .await
                .unwrap()
        ),
        vec![ids[3].to_string(), ids[0].to_string()]
    );
    assert_eq!(
        keys(
            &tx.query(&tasks)
                .with_index("by_status")
                .eq("status", "done")
                .collect()
                .await
                .unwrap()
        ),
        vec![reinserted.to_string()]
    );
    tx.commit().await.unwrap();

    // The snapshot opened before the commit still reads the old index.
    let mut before = before;
    assert_eq!(
        sorted_keys(
            &before
                .query(&tasks)
                .with_index("by_status")
                .eq("status", "done")
                .collect()
                .await
                .unwrap()
        ),
        {
            let mut old = vec![ids[2].to_string(), ids[4].to_string()];
            old.sort();
            old
        }
    );
    before.commit().await.unwrap();

    let mut read = db.read_only().await.unwrap();
    check(&mut read, &tasks).await;
    read.commit().await.unwrap();

    // A rolled-back transaction leaves no index trace either.
    let mut tx = db.begin().await.unwrap();
    tx.patch(&ids[1], fields(&[("status", text("done"))]))
        .await
        .unwrap();
    tx.insert(
        &tasks,
        fields(&[
            ("status", text("done")),
            ("list", text("x")),
            ("rank", int(0)),
        ]),
    )
    .await
    .unwrap();
    tx.delete(&reinserted).await.unwrap();
    tx.rollback().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    check(&mut read, &tasks).await;
    assert_eq!(read.query(&tasks).collect().await.unwrap().len(), 5);
    read.commit().await.unwrap();
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Null, missing and type-sensitive equality.
// ---------------------------------------------------------------------------

backends!(
    memory_index_equality_matches_scan,
    disk_index_equality_matches_scan,
    index_equality_matches_scan
);

// README: indexed equality must stay consistent with the unindexed Rust filter
// (numeric equality across int/float, missing versus null, whole-array values).
// A wrong encoding would make the same `eq` return different rows depending on
// whether `with_index` is used, which callers cannot detect.
async fn index_equality_matches_scan(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let items = table("items");
    let values: Vec<Option<Value>> = vec![
        None,
        Some(Value::Null),
        Some(Value::Bool(false)),
        Some(int(0)),
        Some(text("")),
        Some(text("0")),
        Some(int(2)),
        Some(float(2.0)),
        Some(int(-3)),
        Some(Value::Array(vec![int(1), int(2)].into())),
        Some(Value::Array(vec![int(1)].into())),
        Some(Value::Array(Vec::<Value>::new().into())),
        Some(Value::Object(fields(&[("k", int(1))]))),
    ];
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&items, "by_tag", &["tag"], false)
        .await
        .unwrap();
    for value in &values {
        // Two rows per value so equality must return both, not just one.
        for _ in 0..2 {
            let mut row = Object::new();
            if let Some(value) = value {
                row.insert("tag", value.clone());
            }
            tx.insert(&items, row).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
    let mut tx = db.read_only().await.unwrap();
    let mut probes: Vec<Value> = values
        .iter()
        .map(|v| v.clone().unwrap_or(Value::None))
        .collect();
    probes.extend([int(1), float(-3.0), text("missing")]);
    for probe in probes {
        let scanned = tx
            .query(&items)
            .eq("tag", probe.clone())
            .collect()
            .await
            .unwrap();
        let indexed = tx
            .query(&items)
            .with_index("by_tag")
            .eq("tag", probe.clone())
            .collect()
            .await
            .unwrap();
        assert_eq!(
            sorted_keys(&indexed),
            sorted_keys(&scanned),
            "probe {probe:?}"
        );
    }
    // Spot checks independent of the scan's semantics.
    assert_eq!(
        tx.query(&items)
            .with_index("by_tag")
            .eq("tag", 2i64)
            .collect()
            .await
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        tx.query(&items)
            .with_index("by_tag")
            .eq("tag", Value::Null)
            .collect()
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        tx.query(&items)
            .with_index("by_tag")
            .eq("tag", Value::Array(vec![int(1)].into()))
            .collect()
            .await
            .unwrap()
            .len(),
        2,
        "an array is one whole value, not fanned out into elements"
    );
    tx.commit().await.unwrap();
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Unique indexes.
// ---------------------------------------------------------------------------

backends!(memory_unique_indexes, disk_unique_indexes, unique_indexes);

// Contract 5: a unique index rejects a duplicate key with
// `UniqueViolation { index }`, poisons the call, and leaves data and index
// unchanged; a key can be reused once its holder is deleted or changed, within
// the same transaction. Compound keys are unique only as a whole. Rows that
// lack the field (or hold null) are not duplicates of each other, or optional
// fields could never be unique-indexed. A poisoned call that is dropped, not
// rolled back, must not leak index entries (or partial deletes) to later calls.
async fn unique_indexes(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let users = table("users");
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&users, "by_org_email", &["org", "email"], true)
        .await
        .unwrap();
    tx.define_index(&users, "by_handle", &["handle"], true)
        .await
        .unwrap();
    let ann = tx
        .insert(
            &users,
            fields(&[
                ("org", text("a")),
                ("email", text("x")),
                ("handle", text("ann")),
            ]),
        )
        .await
        .unwrap();
    // Same email, different org: the compound key differs.
    let bob = tx
        .insert(
            &users,
            fields(&[
                ("org", text("b")),
                ("email", text("x")),
                ("handle", text("bob")),
            ]),
        )
        .await
        .unwrap();
    // Missing and null handles are exempt from uniqueness.
    for handle in [None, None, Some(Value::Null), Some(Value::Null)] {
        let mut row = fields(&[("org", text("c")), ("email", text(&uuid_like()))]);
        if let Some(handle) = handle {
            row.insert("handle", handle);
        }
        tx.insert(&users, row).await.unwrap();
    }
    tx.commit().await.unwrap();
    let mut events = db.subscribe();

    async fn by_key(tx: &mut server::data::Transaction, org: &str, email: &str) -> Vec<String> {
        keys(
            &tx.query(&table("users"))
                .with_index("by_org_email")
                .eq("org", org.to_owned())
                .eq("email", email.to_owned())
                .collect()
                .await
                .unwrap(),
        )
    }
    async fn by_handle(tx: &mut server::data::Transaction, handle: &str) -> Vec<String> {
        keys(
            &tx.query(&table("users"))
                .with_index("by_handle")
                .eq("handle", handle.to_owned())
                .collect()
                .await
                .unwrap(),
        )
    }

    // Duplicate compound key on insert: violation names the index, poisons,
    // and the earlier write of the same call is not saved.
    let mut tx = db.begin().await.unwrap();
    let early = tx
        .insert(
            &users,
            fields(&[("org", text("d")), ("email", text("early"))]),
        )
        .await
        .unwrap();
    let error = tx
        .insert(&users, fields(&[("org", text("a")), ("email", text("x"))]))
        .await
        .unwrap_err();
    assert!(
        matches!(&error, Error::UniqueViolation { index } if index == "by_org_email"),
        "{error:?}"
    );
    assert!(!error.is_retryable_conflict());
    assert!(matches!(
        tx.query(&users).collect().await,
        Err(Error::FailedTransaction)
    ));
    assert!(matches!(tx.commit().await, Err(Error::FailedTransaction)));

    // Patch that changes only the first compound field into a taken key, then
    // the poisoned call is dropped without rollback. The update path removes
    // bob's old entry before discovering the conflict; that must not leak.
    let mut tx = db.begin().await.unwrap();
    let leaked = tx
        .insert(
            &users,
            fields(&[
                ("org", text("e")),
                ("email", text("y")),
                ("handle", text("fresh")),
            ]),
        )
        .await
        .unwrap();
    let error = tx
        .patch(&bob, fields(&[("org", text("a"))]))
        .await
        .unwrap_err();
    assert!(
        matches!(&error, Error::UniqueViolation { index } if index == "by_org_email"),
        "{error:?}"
    );
    drop(tx);
    // Single-field unique on patch, rolled back explicitly this time.
    let mut tx = db.begin().await.unwrap();
    let error = tx
        .patch(&bob, fields(&[("handle", text("ann"))]))
        .await
        .unwrap_err();
    assert!(
        matches!(&error, Error::UniqueViolation { index } if index == "by_handle"),
        "{error:?}"
    );
    tx.rollback().await.unwrap();

    let mut read = db.read_only().await.unwrap();
    assert_eq!(by_key(&mut read, "a", "x").await, vec![ann.to_string()]);
    assert_eq!(by_key(&mut read, "b", "x").await, vec![bob.to_string()]);
    assert!(by_key(&mut read, "d", "early").await.is_empty());
    assert!(by_key(&mut read, "e", "y").await.is_empty());
    assert!(by_handle(&mut read, "fresh").await.is_empty());
    assert_eq!(by_handle(&mut read, "ann").await, vec![ann.to_string()]);
    assert_eq!(by_handle(&mut read, "bob").await, vec![bob.to_string()]);
    assert_eq!(
        read.get(&bob).await.unwrap().unwrap().fields.get("org"),
        Some(&text("b"))
    );
    assert_eq!(read.get(&early).await.unwrap(), None);
    assert_eq!(read.get(&leaked).await.unwrap(), None);
    assert_eq!(read.query(&users).collect().await.unwrap().len(), 6);
    read.commit().await.unwrap();
    // None of the failed calls published anything.
    barrier(&db, &mut events).await;

    // Valid edits on rows holding unique keys, and key reuse in one call.
    let mut tx = db.begin().await.unwrap();
    // A non-unique field on a unique-indexed row, and a unique field patched to
    // its own value: neither collides with the row's own entry.
    tx.patch(&ann, fields(&[("name", text("Ann"))]))
        .await
        .unwrap();
    tx.patch(
        &ann,
        fields(&[("handle", text("ann")), ("email", text("x"))]),
    )
    .await
    .unwrap();
    // The value "fresh" from the dropped call is free (no leaked entry).
    let fresh = tx
        .insert(
            &users,
            fields(&[
                ("org", text("e")),
                ("email", text("y")),
                ("handle", text("fresh")),
            ]),
        )
        .await
        .unwrap();
    // Reuse after delete: ann's compound key and handle.
    tx.delete(&ann).await.unwrap();
    let ann2 = tx
        .insert(
            &users,
            fields(&[
                ("org", text("a")),
                ("email", text("x")),
                ("handle", text("ann")),
            ]),
        )
        .await
        .unwrap();
    // Reuse after change: bob moves to a new handle, a new row takes "bob".
    tx.patch(&bob, fields(&[("handle", text("robert"))]))
        .await
        .unwrap();
    let bob2 = tx
        .insert(
            &users,
            fields(&[
                ("org", text("f")),
                ("email", text("z")),
                ("handle", text("bob")),
            ]),
        )
        .await
        .unwrap();
    // Reads in the writing call already see the moved keys.
    assert_eq!(by_handle(&mut tx, "bob").await, vec![bob2.to_string()]);
    assert_eq!(by_key(&mut tx, "a", "x").await, vec![ann2.to_string()]);
    tx.commit().await.unwrap();

    let mut read = db.read_only().await.unwrap();
    assert_eq!(by_key(&mut read, "a", "x").await, vec![ann2.to_string()]);
    assert_eq!(by_handle(&mut read, "ann").await, vec![ann2.to_string()]);
    assert_eq!(by_handle(&mut read, "bob").await, vec![bob2.to_string()]);
    assert_eq!(by_handle(&mut read, "robert").await, vec![bob.to_string()]);
    assert_eq!(by_handle(&mut read, "fresh").await, vec![fresh.to_string()]);
    assert_eq!(read.get(&ann).await.unwrap(), None);
    read.commit().await.unwrap();

    // Still enforced after all the moves.
    let mut tx = db.begin().await.unwrap();
    assert!(matches!(
        tx.insert(
            &users,
            fields(&[
                ("org", text("q")),
                ("email", text("q")),
                ("handle", text("robert"))
            ])
        )
        .await,
        Err(Error::UniqueViolation { .. })
    ));
    drop(tx);
    db.close().await.unwrap();
}

fn uuid_like() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("u{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

// ---------------------------------------------------------------------------
// Concurrency: index entries and definitions across concurrent transactions.
// ---------------------------------------------------------------------------

backends!(
    memory_index_concurrency,
    disk_index_concurrency,
    index_concurrency
);

// Contract 2 + 5: two calls inserting the same unique key cannot both commit,
// and the loser gets a retryable conflict (each snapshot alone saw no
// duplicate). Independent inserts into one non-unique index must not conflict.
// A writer whose snapshot predates an index definition must not commit rows
// that are missing from the new index; it must get a retryable conflict, as
// must a definition racing an active writer, so a replay can succeed.
async fn index_concurrency(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let accounts = table("accounts");
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&accounts, "by_email", &["email"], true)
        .await
        .unwrap();
    tx.define_index(&accounts, "by_team", &["team"], false)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut events = db.subscribe();

    // Same unique key from two snapshots.
    let mut first = db.begin().await.unwrap();
    let mut second = db.begin().await.unwrap();
    let winner = first
        .insert(
            &accounts,
            fields(&[("email", text("e")), ("team", text("t"))]),
        )
        .await
        .unwrap();
    second
        .insert(
            &accounts,
            fields(&[("email", text("e")), ("team", text("t"))]),
        )
        .await
        .unwrap();
    first.commit().await.unwrap();
    assert_eq!(events.try_recv().unwrap().tables, vec![accounts.clone()]);
    let conflict = second.commit().await.unwrap_err();
    assert!(conflict.is_retryable_conflict(), "{conflict:?}");
    // The replay now sees the committed key and reports a real violation.
    let mut replay = db.begin().await.unwrap();
    assert!(matches!(
        replay
            .insert(&accounts, fields(&[("email", text("e"))]))
            .await,
        Err(Error::UniqueViolation { .. })
    ));
    drop(replay);

    // Same non-unique value from two snapshots: both commit.
    let mut first = db.begin().await.unwrap();
    let mut second = db.begin().await.unwrap();
    let a = first
        .insert(
            &accounts,
            fields(&[("email", text("a")), ("team", text("t"))]),
        )
        .await
        .unwrap();
    let b = second
        .insert(
            &accounts,
            fields(&[("email", text("b")), ("team", text("t"))]),
        )
        .await
        .unwrap();
    first.commit().await.unwrap();
    second.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    let mut expected = vec![winner.to_string(), a.to_string(), b.to_string()];
    expected.sort();
    assert_eq!(
        sorted_keys(
            &read
                .query(&accounts)
                .with_index("by_team")
                .eq("team", "t")
                .collect()
                .await
                .unwrap()
        ),
        expected
    );
    assert_eq!(read.query(&accounts).collect().await.unwrap().len(), 3);
    read.commit().await.unwrap();
    while events.try_recv().is_ok() {}

    // A writer that began before an index definition committed.
    let logs = table("logs");
    let mut stale = db.begin().await.unwrap();
    let mut definer = db.begin().await.unwrap();
    definer
        .define_index(&logs, "by_level", &["level"], false)
        .await
        .unwrap();
    definer.commit().await.unwrap();
    let error = stale
        .insert(&logs, fields(&[("level", text("warn"))]))
        .await
        .unwrap_err();
    assert!(error.is_retryable_conflict(), "{error:?}");
    assert!(matches!(
        stale.commit().await,
        Err(Error::FailedTransaction)
    ));
    let mut retry = db.begin().await.unwrap();
    let warn = retry
        .insert(&logs, fields(&[("level", text("warn"))]))
        .await
        .unwrap();
    retry.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert_eq!(
        keys(
            &read
                .query(&logs)
                .with_index("by_level")
                .eq("level", "warn")
                .collect()
                .await
                .unwrap()
        ),
        vec![warn.to_string()]
    );
    read.commit().await.unwrap();

    // A definition while another call is writing the (still empty) table.
    let jobs = table("jobs");
    let mut writer = db.begin().await.unwrap();
    let job = writer
        .insert(&jobs, fields(&[("state", text("new"))]))
        .await
        .unwrap();
    let mut definer = db.begin().await.unwrap();
    let error = definer
        .define_index(&jobs, "by_state", &["state"], false)
        .await
        .unwrap_err();
    assert!(error.is_retryable_conflict(), "{error:?}");
    assert!(matches!(
        definer.commit().await,
        Err(Error::FailedTransaction)
    ));
    writer.commit().await.unwrap();

    // A writer while another call holds an uncommitted definition.
    let queue = table("queue");
    let mut definer = db.begin().await.unwrap();
    definer
        .define_index(&queue, "by_state", &["state"], false)
        .await
        .unwrap();
    let mut writer = db.begin().await.unwrap();
    let error = writer
        .insert(&queue, fields(&[("state", text("new"))]))
        .await
        .unwrap_err();
    assert!(error.is_retryable_conflict(), "{error:?}");
    drop(writer);
    definer.commit().await.unwrap();
    let mut retry = db.begin().await.unwrap();
    let queued = retry
        .insert(&queue, fields(&[("state", text("new"))]))
        .await
        .unwrap();
    retry.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert_eq!(
        keys(
            &read
                .query(&queue)
                .with_index("by_state")
                .eq("state", "new")
                .collect()
                .await
                .unwrap()
        ),
        vec![queued.to_string()]
    );
    assert!(read.get(&job).await.unwrap().is_some());
    read.commit().await.unwrap();
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Persistence of definitions and entries (disk only by nature).
// ---------------------------------------------------------------------------

// Contract 1 + 5: index definitions and entries survive close/reopen; unique
// enforcement and the same-name rules still apply; definitions and tables made
// after reopen get fresh catalog IDs, so a second index on the same table never
// shares the first index's keyspace (which would mix their entries).
#[test]
fn disk_indexes_survive_reopen() {
    run(indexes_survive_reopen);
}

async fn indexes_survive_reopen() {
    let fixture = Fixture::new(true);
    let notes = table("notes");
    let pending = table("pending");
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&notes, "by_slug", &["slug"], true)
        .await
        .unwrap();
    tx.define_index(&notes, "by_rank", &["rank"], false)
        .await
        .unwrap();
    // Defined, but the table stays empty until after reopen.
    tx.define_index(&pending, "by_a", &["a"], false)
        .await
        .unwrap();
    let mut inserted = Vec::new();
    for rank in [3i64, 1, 2] {
        inserted.push((
            rank,
            tx.insert(
                &notes,
                fields(&[("slug", text(&format!("s{rank}"))), ("rank", int(rank))]),
            )
            .await
            .unwrap(),
        ));
    }
    tx.commit().await.unwrap();
    // A rolled-back definition must not persist.
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&table("ghost"), "by_x", &["x"], false)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    db.close().await.unwrap();

    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let mut read = db.read_only().await.unwrap();
    inserted.sort_by_key(|(rank, _)| *rank);
    assert_eq!(
        keys(
            &read
                .query(&notes)
                .with_index("by_rank")
                .collect()
                .await
                .unwrap()
        ),
        inserted
            .iter()
            .map(|(_, id)| id.to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        keys(
            &read
                .query(&notes)
                .with_index("by_slug")
                .eq("slug", "s2")
                .collect()
                .await
                .unwrap()
        ),
        vec![inserted[1].1.to_string()]
    );
    assert!(
        read.query(&table("ghost"))
            .with_index("by_x")
            .collect()
            .await
            .is_err()
    );
    drop(read);

    let mut tx = db.begin().await.unwrap();
    assert!(matches!(
        tx.insert(&notes, fields(&[("slug", text("s1"))])).await,
        Err(Error::UniqueViolation { index }) if index == "by_slug"
    ));
    drop(tx);
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&notes, "by_slug", &["slug"], true)
        .await
        .unwrap();
    assert!(matches!(
        tx.define_index(&notes, "by_slug", &["slug"], false).await,
        Err(Error::Invalid(_))
    ));
    drop(tx);

    // New definitions after reopen: on the pre-existing empty table and on a
    // brand-new table, then rows that populate every index at once.
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&pending, "by_b", &["b"], false)
        .await
        .unwrap();
    let fresh = table("fresh");
    tx.define_index(&fresh, "by_a", &["a"], false)
        .await
        .unwrap();
    let mut rows = Vec::new();
    for (a, b) in [(1i64, 30i64), (2, 20), (3, 10)] {
        rows.push(
            tx.insert(&pending, fields(&[("a", int(a)), ("b", int(b))]))
                .await
                .unwrap(),
        );
        tx.insert(&fresh, fields(&[("a", int(a))])).await.unwrap();
    }
    tx.commit().await.unwrap();
    let mut read = db.read_only().await.unwrap();
    assert_eq!(
        keys(
            &read
                .query(&pending)
                .with_index("by_a")
                .collect()
                .await
                .unwrap()
        ),
        vec![
            rows[0].to_string(),
            rows[1].to_string(),
            rows[2].to_string()
        ]
    );
    assert_eq!(
        keys(
            &read
                .query(&pending)
                .with_index("by_b")
                .collect()
                .await
                .unwrap()
        ),
        vec![
            rows[2].to_string(),
            rows[1].to_string(),
            rows[0].to_string()
        ]
    );
    assert_eq!(
        read.query(&fresh)
            .with_index("by_a")
            .collect()
            .await
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        read.query(&notes)
            .with_index("by_rank")
            .collect()
            .await
            .unwrap()
            .len(),
        3
    );
    read.commit().await.unwrap();
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Many rows: storage scan batches and large index ranges.
// ---------------------------------------------------------------------------

backends!(memory_many_rows, disk_many_rows, many_rows);

// Contract 4 + 5: with a few hundred rows, scans that cross any storage batch
// boundary still return every row exactly once, index ranges stay exact in
// both directions and with limits, and bulk patch/delete leaves no stale
// entries. The large commit's event falls back to a table invalidation.
async fn many_rows(disk: bool) {
    const COUNT: i64 = 300;
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let points = table("points");
    let mut events = db.subscribe();
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&points, "by_n", &["n"], false)
        .await
        .unwrap();
    let mut by_n = std::collections::BTreeMap::new();
    for i in 0..COUNT {
        // Insertion order is a permutation, so ID/creation order is not n order.
        let n = (i * 7919) % COUNT;
        let id = tx
            .insert(&points, fields(&[("n", int(n)), ("parity", int(n % 2))]))
            .await
            .unwrap();
        by_n.insert(n, id);
    }
    tx.commit().await.unwrap();
    let event = events.try_recv().unwrap();
    assert_eq!(event.tables, vec![points.clone()]);
    assert_eq!(
        event.records, None,
        "300 changes exceed the 64-record retention bound"
    );

    let ids = |range: std::ops::Range<i64>| range.map(|n| by_n[&n].to_string()).collect::<Vec<_>>();
    let mut tx = db.read_only().await.unwrap();
    assert_eq!(
        tx.query(&points).collect().await.unwrap().len(),
        COUNT as usize
    );
    assert_eq!(
        tx.query(&points)
            .eq("parity", 0i64)
            .collect()
            .await
            .unwrap()
            .len(),
        150
    );
    assert_eq!(
        keys(
            &tx.query(&points)
                .with_index("by_n")
                .collect()
                .await
                .unwrap()
        ),
        ids(0..COUNT)
    );
    assert_eq!(
        keys(
            &tx.query(&points)
                .with_index("by_n")
                .gte("n", 37i64)
                .lt("n", 263i64)
                .collect()
                .await
                .unwrap()
        ),
        ids(37..263)
    );
    let mut top = ids(163..263);
    top.reverse();
    assert_eq!(
        keys(
            &tx.query(&points)
                .with_index("by_n")
                .gte("n", 37i64)
                .lt("n", 263i64)
                .order(Order::Desc)
                .take(100)
                .await
                .unwrap()
        ),
        top
    );
    tx.commit().await.unwrap();

    // Move every third row out of the range and delete every fifth.
    let mut tx = db.begin().await.unwrap();
    let mut expected = std::collections::BTreeMap::new();
    for (n, id) in &by_n {
        if n % 5 == 0 {
            tx.delete(id).await.unwrap();
        } else if n % 3 == 0 {
            tx.patch(id, fields(&[("n", int(n + 1000))])).await.unwrap();
            expected.insert(n + 1000, id.to_string());
        } else {
            expected.insert(*n, id.to_string());
        }
    }
    tx.commit().await.unwrap();
    let mut tx = db.read_only().await.unwrap();
    assert_eq!(
        keys(
            &tx.query(&points)
                .with_index("by_n")
                .collect()
                .await
                .unwrap()
        ),
        expected.values().cloned().collect::<Vec<_>>()
    );
    assert_eq!(
        keys(
            &tx.query(&points)
                .with_index("by_n")
                .gte("n", 1000i64)
                .collect()
                .await
                .unwrap()
        ),
        expected
            .range(1000..)
            .map(|(_, id)| id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        tx.query(&points).collect().await.unwrap().len(),
        expected.len()
    );
    tx.commit().await.unwrap();
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Change events: record images and overflow.
// ---------------------------------------------------------------------------

backends!(memory_change_records, disk_change_records, change_records);

// Contract 6: a commit publishes one event whose records carry the before and
// after images of each written row (`_id`, `_creationTime` and fields), which
// reactive reads match against. More than 64 changes or more than 32 KiB of
// images collapses to a table-level invalidation (records None) that still
// names every written table. Read-only calls and unique failures publish none.
async fn change_records(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let things = table("things");
    let other = table("other");
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&things, "by_u", &["u"], true)
        .await
        .unwrap();
    let patched = tx.insert(&things, fields(&[("v", int(1))])).await.unwrap();
    let deleted = tx.insert(&things, fields(&[("v", int(2))])).await.unwrap();
    let replaced = tx
        .insert(
            &things,
            fields(&[("v", int(3)), ("extra", Value::Bool(true))]),
        )
        .await
        .unwrap();
    tx.insert(&things, fields(&[("u", text("taken"))]))
        .await
        .unwrap();
    let time = |doc: Option<Document>| doc.unwrap().creation_time;
    let (pt, dt, rt) = (
        time(tx.get(&patched).await.unwrap()),
        time(tx.get(&deleted).await.unwrap()),
        time(tx.get(&replaced).await.unwrap()),
    );
    tx.commit().await.unwrap();
    let mut events = db.subscribe();

    let mut tx = db.begin().await.unwrap();
    let created = tx
        .insert(&things, fields(&[("v", int(4)), ("s", text("雪 ✓"))]))
        .await
        .unwrap();
    tx.patch(&patched, fields(&[("v", int(10))])).await.unwrap();
    tx.delete(&deleted).await.unwrap();
    tx.replace(&replaced, fields(&[("w", text("x"))]))
        .await
        .unwrap();
    let marker = tx.insert(&other, Object::new()).await.unwrap();
    let ct = time(tx.get(&created).await.unwrap());
    let mt = time(tx.get(&marker).await.unwrap());
    tx.commit().await.unwrap();
    let event = events.try_recv().unwrap();
    assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
    assert_eq!(event.tables, vec![other.clone(), things.clone()]);
    let records = event.records.expect("five small changes are retained");
    assert_eq!(records.len(), 5);
    let find = |id: &Id| {
        let found: Vec<_> = records.iter().filter(|change| &change.id == id).collect();
        assert_eq!(found.len(), 1, "{id}");
        (found[0].before.clone(), found[0].after.clone())
    };
    assert_eq!(
        find(&created),
        (
            None,
            Some(json!({"_id": created.to_string(), "_creationTime": ct, "v": 4, "s": "雪 ✓"}))
        )
    );
    assert_eq!(
        find(&patched),
        (
            Some(json!({"_id": patched.to_string(), "_creationTime": pt, "v": 1})),
            Some(json!({"_id": patched.to_string(), "_creationTime": pt, "v": 10}))
        )
    );
    assert_eq!(
        find(&deleted),
        (
            Some(json!({"_id": deleted.to_string(), "_creationTime": dt, "v": 2})),
            None
        )
    );
    assert_eq!(
        find(&replaced),
        (
            Some(json!({"_id": replaced.to_string(), "_creationTime": rt, "v": 3, "extra": true})),
            Some(json!({"_id": replaced.to_string(), "_creationTime": rt, "w": "x"}))
        )
    );
    assert_eq!(
        find(&marker),
        (
            None,
            Some(json!({"_id": marker.to_string(), "_creationTime": mt}))
        )
    );

    // Count bound: 64 retained, 65 collapse, and the table list stays complete
    // even for tables written only after the collapse.
    // `count` is the total number of changes; the last one goes to `other`.
    for (count, retained) in [(63usize, true), (64, true), (65, false), (200, false)] {
        let mut tx = db.begin().await.unwrap();
        for _ in 0..count - 1 {
            tx.insert(&things, Object::new()).await.unwrap();
        }
        tx.insert(&other, Object::new()).await.unwrap();
        tx.commit().await.unwrap();
        let event = events.try_recv().unwrap();
        assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
        assert_eq!(event.tables, vec![other.clone(), things.clone()], "{count}");
        match (retained, &event.records) {
            (true, Some(records)) => assert_eq!(records.len(), count),
            (false, None) => {}
            (_, records) => panic!(
                "{count} changes: records {:?}",
                records.as_ref().map(Vec::len)
            ),
        }
    }

    // Byte bound: two ~10 KB images fit in 32 KiB, four do not; one 33 KB
    // image alone does not either.
    let big = "y".repeat(10_000);
    for (rows, size, retained) in [
        (2, big.as_str(), true),
        (4, big.as_str(), false),
        (1, &*"z".repeat(33_000), false),
    ] {
        let mut tx = db.begin().await.unwrap();
        for _ in 0..rows {
            tx.insert(&things, fields(&[("blob", text(size))]))
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        let event = events.try_recv().unwrap();
        assert_eq!(event.tables, vec![things.clone()]);
        assert_eq!(
            event.records.is_some(),
            retained,
            "{rows} x {} bytes",
            size.len()
        );
    }
    // Overflow on a patch's before+after pair, after small changes were kept.
    let mut tx = db.begin().await.unwrap();
    tx.insert(&things, Object::new()).await.unwrap();
    tx.patch(&patched, fields(&[("blob", text(&"p".repeat(20_000)))]))
        .await
        .unwrap();
    tx.patch(&patched, fields(&[("blob", text(&"q".repeat(20_000)))]))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(events.try_recv().unwrap().records, None);

    // Read-only and failed unique writes publish nothing.
    let mut read = db.read_only().await.unwrap();
    read.query(&things).collect().await.unwrap();
    read.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.insert(&other, Object::new()).await.unwrap();
    assert!(
        tx.insert(&things, fields(&[("u", text("taken"))]))
            .await
            .is_err()
    );
    assert!(tx.commit().await.is_err());
    barrier(&db, &mut events).await;
    db.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// Value fidelity through the storage value conversion.
// ---------------------------------------------------------------------------

backends!(
    memory_values_round_trip,
    disk_values_round_trip,
    values_round_trip
);

// Contract 3: JSON-like values survive the explicit public <-> storage value
// conversion unchanged, including number kinds (an integer must not come back
// as a float or vice versa), extremes, unicode, empty containers and deep
// mixtures; on disk they also survive reopen. Unindexed and indexed equality
// on whole nested values finds the row.
async fn values_round_trip(disk: bool) {
    let fixture = Fixture::new(disk);
    let mut db = Database::open(fixture.storage.clone()).await.unwrap();
    let docs = table("docs");
    let nested = Value::Object(fields(&[
        (
            "list",
            Value::Array(
                vec![
                    int(1),
                    text("two"),
                    Value::Null,
                    Value::Object(fields(&[(
                        "x",
                        Value::Array(vec![Value::Bool(true)].into()),
                    )])),
                ]
                .into(),
            ),
        ),
        ("empty_list", Value::Array(Vec::<Value>::new().into())),
        ("empty_object", Value::Object(Object::new())),
    ]));
    let original = fields(&[
        (
            "unicode",
            text("雪 ❄️ e\u{301} \u{1F600} \"quoted\" \\ \n\t"),
        ),
        ("empty", text("")),
        ("max", int(i64::MAX)),
        ("min", int(i64::MIN)),
        ("zero", int(0)),
        ("negative", int(-42)),
        ("half", float(1.5)),
        ("negative_float", float(-0.25)),
        ("integral_float", float(2.0)),
        ("huge", float(1e300)),
        ("tiny", float(f64::MIN_POSITIVE)),
        ("yes", Value::Bool(true)),
        ("no", Value::Bool(false)),
        ("nothing", Value::Null),
        ("nested", nested.clone()),
    ]);
    let mut tx = db.begin().await.unwrap();
    tx.define_index(&docs, "by_nested", &["nested"], false)
        .await
        .unwrap();
    let id = tx.insert(&docs, original.clone()).await.unwrap();
    tx.insert(
        &docs,
        fields(&[("nested", Value::Array(vec![int(1)].into()))]),
    )
    .await
    .unwrap();
    assert_eq!(tx.get(&id).await.unwrap().unwrap().fields, original);
    tx.commit().await.unwrap();

    let check = |fields: &Object| {
        assert_eq!(fields, &original);
        // PartialEq may equate 2 and 2.0; the stored number kind must not change.
        for (key, int_kind) in [
            ("max", true),
            ("zero", true),
            ("integral_float", false),
            ("half", false),
        ] {
            match fields.get(key) {
                Some(Value::Number(Number::Int(_))) => assert!(int_kind, "{key} became an integer"),
                Some(Value::Number(Number::Float(_))) => assert!(!int_kind, "{key} became a float"),
                other => panic!("{key}: {other:?}"),
            }
        }
    };
    if disk {
        db.close().await.unwrap();
        db = Database::open(fixture.storage.clone()).await.unwrap();
    }
    let mut read = db.read_only().await.unwrap();
    check(&read.get(&id).await.unwrap().unwrap().fields);
    assert_eq!(
        keys(
            &read
                .query(&docs)
                .eq("nested", nested.clone())
                .collect()
                .await
                .unwrap()
        ),
        vec![id.to_string()]
    );
    assert_eq!(
        keys(
            &read
                .query(&docs)
                .with_index("by_nested")
                .eq("nested", nested.clone())
                .collect()
                .await
                .unwrap()
        ),
        vec![id.to_string()]
    );
    assert_eq!(
        keys(
            &read
                .query(&docs)
                .eq("unicode", original.get("unicode").unwrap().clone())
                .collect()
                .await
                .unwrap()
        ),
        vec![id.to_string()]
    );
    assert_eq!(
        keys(
            &read
                .query(&docs)
                .eq("max", i64::MAX)
                .collect()
                .await
                .unwrap()
        ),
        vec![id.to_string()]
    );
    read.commit().await.unwrap();
    // Patch and replace use the same conversion as insert.
    let mut tx = db.begin().await.unwrap();
    tx.replace(&id, Object::new()).await.unwrap();
    tx.patch(&id, original.clone()).await.unwrap();
    check(&tx.get(&id).await.unwrap().unwrap().fields);
    tx.commit().await.unwrap();
    db.close().await.unwrap();
}
