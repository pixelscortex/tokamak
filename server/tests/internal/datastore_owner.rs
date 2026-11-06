//! Private TKM7 diagnostic tests: native visibility is not a feature capability.
//! No second SDK attachment or independent opener is created for an active DB.
use super::*;
use std::{future::Future, time::Duration};
use surrealdb_core::dbs::Session;
use tokio::sync::broadcast::error::TryRecvError;

fn run(scenario: impl FnOnce() -> Pin<Box<dyn Future<Output = ()>>> + Send + 'static) {
    // Only this native SQL diagnostic uses the pre-existing data-test stack
    // convention. Real Backend/QuickJS acceptance keeps production-sized stacks.
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
async fn native(db: &Database, sql: &str) -> Value {
    let mut results = db
        .datastore()
        .unwrap()
        .execute(
            sql,
            &Session::owner().with_ns("tokamak").with_db("tokamak"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    results.remove(0).result.unwrap()
}
fn fields(value: i64) -> Object {
    let mut fields = Object::new();
    fields.insert("value", Value::from_int(value));
    fields
}

// Acceptance: retained explicit owner and attached public SDK read/write the
// SAME storage and transaction boundaries. Uncommitted/rolled-back data is not
// native-visible; native writes are SDK-visible but do not fake tracked events.
#[test]
fn explicit_owner_and_sdk_share_native_storage_and_transactions() {
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
                let weak = Arc::downgrade(db.datastore().unwrap());
                let mut events = db.subscribe();
                // Native bootstrap of a canonical record avoids table-creation races
                // while proving visibility in the opposite direction to SDK writes.
                native(
                    &db,
                    "CREATE items:fixed CONTENT { _creationTime: 7, data: { value: 1 } }",
                )
                .await;
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
                assert_eq!(
                    native(
                        &db,
                        "RETURN (SELECT VALUE data.value FROM ONLY items:fixed)"
                    )
                    .await,
                    Value::from_int(1)
                );
                writer.rollback().await.unwrap();
                assert_eq!(
                    native(
                        &db,
                        "RETURN (SELECT VALUE data.value FROM ONLY items:fixed)"
                    )
                    .await,
                    Value::from_int(1)
                );
                assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
                let mut writer = db.begin().await.unwrap();
                writer.patch(&id, fields(3)).await.unwrap();
                writer.commit().await.unwrap();
                assert_eq!(
                    events.try_recv().unwrap().tables,
                    vec![Table::new("items").unwrap()]
                );
                assert_eq!(
                    native(
                        &db,
                        "RETURN (SELECT VALUE data.value FROM ONLY items:fixed)"
                    )
                    .await,
                    Value::from_int(3)
                );
                assert_eq!(events.try_recv(), Err(TryRecvError::Empty));
                // Arc identity survives every transaction; close must drop ALL SDK
                // and owner references, not merely call shutdown on one attachment.
                assert!(Arc::ptr_eq(
                    db.datastore().unwrap(),
                    &weak.upgrade().unwrap()
                ));
                db.close().await.unwrap();
                assert!(
                    weak.upgrade().is_none(),
                    "successful close retained native storage ownership"
                );
                db.close().await.unwrap();
                assert_eq!(events.try_recv(), Err(TryRecvError::Closed));
                if disk {
                    let mut reopened = Database::open(storage).await.unwrap();
                    assert_eq!(
                        native(
                            &reopened,
                            "RETURN (SELECT VALUE data.value FROM ONLY items:fixed)"
                        )
                        .await,
                        Value::from_int(3)
                    );
                    reopened.close().await.unwrap();
                    std::fs::remove_dir_all(directory).unwrap();
                }
            }
        })
    });
}

// Acceptance: typed conflicts are native transaction conflicts on this supplied
// datastore, not message matching or errors manufactured by a test engine.
#[test]
fn native_owner_commit_conflicts_with_attached_sdk_snapshot() {
    run(|| {
        Box::pin(async {
            let mut db = Database::open(Storage::Memory).await.unwrap();
            native(
                &db,
                "CREATE items:fixed CONTENT { _creationTime: 7, data: { value: 1 } }",
            )
            .await;
            let id: Id = "items:fixed".parse().unwrap();
            let mut loser = db.begin().await.unwrap();
            loser.patch(&id, fields(2)).await.unwrap();
            native(&db, "UPDATE items:fixed SET data.value = 3").await;
            let conflict = loser.commit().await.unwrap_err();
            assert!(
                conflict.is_retryable_conflict(),
                "native conflict lost its typed identity: {conflict}"
            );
            assert_eq!(
                native(
                    &db,
                    "RETURN (SELECT VALUE data.value FROM ONLY items:fixed)"
                )
                .await,
                Value::from_int(3)
            );
            db.close().await.unwrap();
        })
    });
}
