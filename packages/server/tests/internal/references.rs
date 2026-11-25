use super::*;
use crate::data::{Database, Object, Storage, json_object};
use serde_json::json;

use crate::schema::{RefTargets, Schema};

fn link_schema(kind: serde_json::Value) -> Schema {
    Schema::parse(&json!({"tables": {
        "links": {"description": {"kind": "object", "fields": {"item": kind}}}
    }}))
    .unwrap()
}

async fn apply(tx: &mut Transaction, space: &DataSpace, schema: Schema) {
    schema
        .apply(
            tx,
            space,
            RefTargets {
                depends: &BTreeMap::from([("owner".into(), "*".into())]),
                declares: &|owner, table| owner == "owner" && table == "items",
            },
            false,
        )
        .await
        .unwrap();
}

fn ref_schema() -> Schema {
    link_schema(json!({"kind": "ref", "table": "owner.items"}))
}

fn ref_value(owner: &DataSpace, id: &Id) -> Object {
    json_object(&json!({"item": owner.present_id(id).unwrap()})).unwrap()
}

async fn check_reference_conflicts(storage: Storage) {
    let mut database = Database::open(storage).await.unwrap();
    let owner = DataSpace::plugin("owner").unwrap();
    let dependent = DataSpace::plugin("dependent").unwrap();
    let items = owner.table(&Table::new("items").unwrap()).unwrap();
    let unrelated = owner.table(&Table::new("unrelated").unwrap()).unwrap();
    let links = dependent.table(&Table::new("links").unwrap()).unwrap();

    let mut setup = database.begin().await.unwrap();
    apply(&mut setup, &dependent, ref_schema()).await;
    setup.insert(&unrelated, Default::default()).await.unwrap();
    let id = setup.insert(&items, Default::default()).await.unwrap();
    let value = ref_value(&owner, &id);
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

    let mut reference = database.begin().await.unwrap();
    let mut delete = database.begin().await.unwrap();
    delete.delete(&id).await.unwrap();
    reference.insert(&links, value.clone()).await.unwrap();
    reference.commit().await.unwrap();
    assert!(delete.commit().await.unwrap_err().is_retryable_conflict());

    let mut reference = database.begin().await.unwrap();
    let mut delete = database.begin().await.unwrap();
    reference.insert(&links, value.clone()).await.unwrap();
    delete.delete(&id).await.unwrap();
    delete.commit().await.unwrap();
    assert!(
        reference
            .commit()
            .await
            .unwrap_err()
            .is_retryable_conflict()
    );

    let mut read = database.read_only().await.unwrap();
    assert!(read.get(&id).await.unwrap().is_none());
    assert!(read.get(&link).await.unwrap().is_none());
    read.commit().await.unwrap();
    database.close().await.unwrap();
}

#[tokio::test]
async fn reference_targets_conflict_without_serializing_independent_writers() {
    check_reference_conflicts(Storage::Memory).await;
    let directory = tempfile::tempdir().unwrap();
    check_reference_conflicts(Storage::Disk(directory.path().join("store"))).await;
}

struct Rows {
    database: Database,
    owner: DataSpace,
    dependent: DataSpace,
    links: Table,
    first: Id,
    second: Id,
}

impl Rows {
    async fn new(with_ref: bool) -> Self {
        let database = Database::open(Storage::Memory).await.unwrap();
        let owner = DataSpace::plugin("owner").unwrap();
        let dependent = DataSpace::plugin("dependent").unwrap();
        let items = owner.table(&Table::new("items").unwrap()).unwrap();
        let links = dependent.table(&Table::new("links").unwrap()).unwrap();
        let mut tx = database.begin().await.unwrap();
        if with_ref {
            apply(&mut tx, &dependent, ref_schema()).await;
        }
        let first = tx.insert(&items, Default::default()).await.unwrap();
        let second = tx.insert(&items, Default::default()).await.unwrap();
        tx.commit().await.unwrap();

        Self {
            database,
            owner,
            dependent,
            links,
            first,
            second,
        }
    }
}

#[tokio::test]
async fn ref_inserts_to_the_same_target_retry() {
    let mut rows = Rows::new(true).await;
    let value = ref_value(&rows.owner, &rows.first);
    let mut first = rows.database.begin().await.unwrap();
    let mut second = rows.database.begin().await.unwrap();
    let first_id = first.insert(&rows.links, value.clone()).await.unwrap();
    second.insert(&rows.links, value.clone()).await.unwrap();
    first.commit().await.unwrap();
    assert!(second.commit().await.unwrap_err().is_retryable_conflict());

    let mut retry = rows.database.begin().await.unwrap();
    let second_id = retry.insert(&rows.links, value).await.unwrap();
    retry.commit().await.unwrap();

    let mut read = rows.database.read_only().await.unwrap();
    assert!(read.get(&first_id).await.unwrap().is_some());
    assert!(read.get(&second_id).await.unwrap().is_some());
    read.commit().await.unwrap();
    rows.database.close().await.unwrap();
}

#[tokio::test]
async fn owner_patch_and_ref_insert_commit_without_conflict() {
    let mut rows = Rows::new(true).await;
    let mut reference = rows.database.begin().await.unwrap();
    let mut patch = rows.database.begin().await.unwrap();
    reference
        .insert(&rows.links, ref_value(&rows.owner, &rows.first))
        .await
        .unwrap();
    patch
        .patch(&rows.first, json_object(&json!({"updatedAt": 1})).unwrap())
        .await
        .unwrap();
    patch.commit().await.unwrap();
    reference.commit().await.unwrap();
    rows.database.close().await.unwrap();
}

#[tokio::test]
async fn patch_changing_a_ref_conflicts_with_delete_of_new_target() {
    let mut rows = Rows::new(true).await;
    let mut setup = rows.database.begin().await.unwrap();
    let link = setup
        .insert(&rows.links, ref_value(&rows.owner, &rows.first))
        .await
        .unwrap();
    setup.commit().await.unwrap();

    let mut patch = rows.database.begin().await.unwrap();
    let mut delete = rows.database.begin().await.unwrap();
    patch
        .patch(&link, ref_value(&rows.owner, &rows.second))
        .await
        .unwrap();
    delete.delete(&rows.second).await.unwrap();
    delete.commit().await.unwrap();
    assert!(patch.commit().await.unwrap_err().is_retryable_conflict());

    let mut retry = rows.database.begin().await.unwrap();
    assert!(
        retry
            .patch(&link, ref_value(&rows.owner, &rows.second))
            .await
            .unwrap_err()
            .to_string()
            .contains("referenced row does not exist")
    );
    retry.rollback().await.unwrap();
    rows.database.close().await.unwrap();
}

#[tokio::test]
async fn hidden_ref_index_backfills_existing_rows_and_is_dropped_with_the_ref() {
    let mut rows = Rows::new(false).await;
    let mut seed = rows.database.begin().await.unwrap();
    let first = seed
        .insert(&rows.links, ref_value(&rows.owner, &rows.first))
        .await
        .unwrap();
    let second = seed
        .insert(&rows.links, ref_value(&rows.owner, &rows.second))
        .await
        .unwrap();
    seed.commit().await.unwrap();

    let mut install = rows.database.begin().await.unwrap();
    apply(&mut install, &rows.dependent, ref_schema()).await;
    install.commit().await.unwrap();

    let mut delete = rows.database.begin().await.unwrap();
    delete.delete(&rows.first).await.unwrap();
    assert!(delete.get(&first).await.unwrap().is_none());
    delete.commit().await.unwrap();

    let mut remove = rows.database.begin().await.unwrap();
    apply(
        &mut remove,
        &rows.dependent,
        link_schema(json!({"kind": "string"})),
    )
    .await;
    let core = &remove.state.storage;
    assert!(
        remove
            .inner
            .get_tb_index(
                core.ns,
                core.db,
                &rows.links.as_str().into(),
                "$ref:item",
                None
            )
            .await
            .unwrap()
            .is_none()
    );
    remove.delete(&rows.second).await.unwrap();
    assert!(remove.get(&second).await.unwrap().is_some());
    remove.commit().await.unwrap();
    rows.database.close().await.unwrap();
}
