//! Private TKM7 diagnostic tests: native visibility is not a feature capability.
//! Raw diagnostics share the owner's factory and never publish tracked events.
use super::*;
use std::{future::Future, time::Duration};
use surrealdb_idx::catalog::{Record, providers::*};
use surrealdb_kvs::TransactionType;
use tokio::sync::broadcast::error::TryRecvError;

fn run(scenario: impl FnOnce() -> Pin<Box<dyn Future<Output = ()>>> + Send + 'static) {
    // Retain the existing diagnostic test harness; production uses ordinary stacks.
    let thread = std::thread::Builder::new()
        .name("tkm7-native-storage".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(Duration::from_secs(60), scenario())
                        .await
                        .unwrap();
                });
        })
        .unwrap();
    if let Err(panic) = thread.join() {
        std::panic::resume_unwind(panic);
    }
}
async fn native(db: &Database, write: Option<i64>) -> Value {
    let state = db.state().unwrap();
    let core = &state.storage;
    let tx = core
        .factory
        .transaction(
            if write.is_some() {
                TransactionType::Write
            } else {
                TransactionType::Read
            },
            core.sequences.clone(),
        )
        .await
        .unwrap();
    let id: Id = "items:fixed".parse().unwrap();
    let rid = id.record();
    if let Some(value) = write {
        tx.get_or_add_tb(None, "tokamak", "tokamak", &rid.table, None)
            .await
            .unwrap();
        let row = Document {
            id,
            creation_time: 7,
            fields: fields(value),
        };
        tx.set_record(
            core.ns,
            core.db,
            &rid.table,
            &rid.key,
            Arc::new(Record::new(row.stored())),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        Value::from_int(value)
    } else {
        let row = tx
            .get_record(core.ns, core.db, &rid.table, &rid.key, None)
            .await
            .unwrap();
        let row = Document::decode(row.data.clone()).unwrap();
        tx.cancel().await.unwrap();
        row.fields.get("value").unwrap().clone()
    }
}
fn fields(value: i64) -> Object {
    let mut fields = Object::new();
    fields.insert("value", Value::from_int(value));
    fields
}

// Acceptance: raw and tracked transactions share the SAME storage and snapshot
// boundaries. Raw diagnostic writes do not fake tracked change events.
#[test]
fn explicit_owner_and_tracked_share_native_storage_and_transactions() {
    run(|| {
        Box::pin(async {
            for disk in [false, true] {
                let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("target")
                    .join(format!("tkm7-owner-{}", std::process::id()));
                if disk {
                    std::fs::create_dir_all(&directory).unwrap();
                }
                let storage = if disk {
                    Storage::Disk(directory.join("db"))
                } else {
                    Storage::Memory
                };
                let mut db = Database::open(storage.clone()).await.unwrap();
                let weak = Arc::downgrade(db.state().unwrap());
                let mut events = db.subscribe();
                // Native bootstrap of a canonical record avoids table-creation races
                // while proving visibility in the opposite direction to tracked writes.
                native(&db, Some(1)).await;
                assert_eq!(
                    events.try_recv(),
                    Err(TryRecvError::Empty),
                    "raw diagnostic writes are deliberately not tracked"
                );
                let id: Id = "items:fixed".parse().unwrap();
                let mut reader = db.read_only().await.unwrap();
                assert_eq!(reader.get(&id).await.unwrap().unwrap().fields, fields(1));
                reader.rollback().await.unwrap();
                let mut writer = db.begin().await.unwrap();
                writer.patch(&id, fields(2)).await.unwrap();
                assert_eq!(native(&db, None).await, Value::from_int(1));
                writer.rollback().await.unwrap();
                assert_eq!(native(&db, None).await, Value::from_int(1));
                assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
                let mut writer = db.begin().await.unwrap();
                writer.patch(&id, fields(3)).await.unwrap();
                writer.commit().await.unwrap();
                assert_eq!(
                    events.try_recv().unwrap().tables,
                    vec![Table::new("items").unwrap()]
                );
                assert_eq!(native(&db, None).await, Value::from_int(3));
                assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
                // Arc identity survives every transaction; close must drop ALL tracked
                // and owner references, not merely call shutdown on one attachment.
                assert!(Arc::ptr_eq(db.state().unwrap(), &weak.upgrade().unwrap()));
                db.close().await.unwrap();
                assert!(
                    weak.upgrade().is_none(),
                    "successful close retained native storage ownership"
                );
                db.close().await.unwrap();
                assert_eq!(events.try_recv(), Err(TryRecvError::Closed));
                if disk {
                    let mut reopened = Database::open(storage).await.unwrap();
                    assert_eq!(native(&reopened, None).await, Value::from_int(3));
                    reopened.close().await.unwrap();
                    std::fs::remove_dir_all(directory).unwrap();
                }
            }
        })
    });
}

// Acceptance: typed conflicts are native transaction conflicts on this supplied
// storage, not message matching or errors manufactured by a test engine.
#[test]
fn native_owner_commit_conflicts_with_attached_tracked_snapshot() {
    run(|| {
        Box::pin(async {
            let mut db = Database::open(Storage::Memory).await.unwrap();
            native(&db, Some(1)).await;
            let id: Id = "items:fixed".parse().unwrap();
            let mut loser = db.begin().await.unwrap();
            loser.patch(&id, fields(2)).await.unwrap();
            native(&db, Some(3)).await;
            let conflict = loser.commit().await.unwrap_err();
            assert!(
                conflict.is_retryable_conflict(),
                "native conflict lost its typed identity: {conflict}"
            );
            assert_eq!(native(&db, None).await, Value::from_int(3));
            db.close().await.unwrap();
        })
    });
}
