use super::*;
use crate::data::{Database, Storage, json_object};
use serde_json::json;

async fn schema(tx: &mut Transaction, owner: &DataSpace, dependent: &DataSpace) {
    crate::schema::Schema::parse(&json!({"tables": {
        "links": {"description": {"kind": "object", "fields": {
            "item": {"kind": "ref", "table": "owner.items"}
        }}}
    }}))
    .unwrap()
    .apply(tx, dependent, false)
    .await
    .unwrap();
    tx.insert(
        &owner.table(&Table::new("unrelated").unwrap()).unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
}

async fn check_reference_conflicts(storage: Storage) {
    let mut database = Database::open(storage).await.unwrap();
    let owner = DataSpace::plugin("owner").unwrap();
    let dependent = DataSpace::plugin("dependent").unwrap();
    let items = owner.table(&Table::new("items").unwrap()).unwrap();
    let unrelated = owner.table(&Table::new("unrelated").unwrap()).unwrap();
    let links = dependent.table(&Table::new("links").unwrap()).unwrap();

    let mut setup = database.begin().await.unwrap();
    schema(&mut setup, &owner, &dependent).await;
    let id = setup.insert(&items, Default::default()).await.unwrap();
    let value = json_object(&json!({"item": owner.present_id(&id).unwrap()})).unwrap();
    setup.commit().await.unwrap();

    let mut reference = database.begin().await.unwrap();
    let mut independent = database.begin().await.unwrap();
    let link = reference.insert(&links, value.clone()).await.unwrap();
    independent
        .insert(&unrelated, Default::default())
        .await
        .unwrap();
    independent.commit().await.unwrap();
    reference.commit().await.unwrap();

    for delete_first in [false, true] {
        let mut reference = database.begin().await.unwrap();
        let mut delete = database.begin().await.unwrap();
        delete.delete(&id).await.unwrap();
        reference.insert(&links, value.clone()).await.unwrap();

        let (winner, loser) = if delete_first {
            (delete, reference)
        } else {
            (reference, delete)
        };
        winner.commit().await.unwrap();
        assert!(loser.commit().await.unwrap_err().is_retryable_conflict());

        if delete_first {
            let mut read = database.read_only().await.unwrap();
            assert!(read.get(&id).await.unwrap().is_none());
            assert!(read.get(&link).await.unwrap().is_none());
            read.commit().await.unwrap();
            break;
        }
    }
    database.close().await.unwrap();
}

#[tokio::test]
async fn reference_targets_conflict_without_serializing_independent_writers() {
    check_reference_conflicts(Storage::Memory).await;
    let directory = tempfile::tempdir().unwrap();
    check_reference_conflicts(Storage::Disk(directory.path().join("store"))).await;
}

#[tokio::test]
async fn resetting_schema_cascades_through_the_normal_delete_path() {
    let mut database = Database::open(Storage::Memory).await.unwrap();
    let owner = DataSpace::plugin("owner").unwrap();
    let dependent = DataSpace::plugin("dependent").unwrap();
    let items = owner.table(&Table::new("items").unwrap()).unwrap();
    let links = dependent.table(&Table::new("links").unwrap()).unwrap();

    let mut tx = database.begin().await.unwrap();
    schema(&mut tx, &owner, &dependent).await;
    let id = tx.insert(&items, Default::default()).await.unwrap();
    let value = json_object(&json!({"item": owner.present_id(&id).unwrap()})).unwrap();
    let link = tx.insert(&links, value).await.unwrap();

    tx.reset_schema_space(&owner, &BTreeSet::new())
        .await
        .unwrap();
    assert!(tx.get(&id).await.unwrap().is_none());
    assert!(tx.get(&link).await.unwrap().is_none());
    tx.commit().await.unwrap();
    database.close().await.unwrap();
}
