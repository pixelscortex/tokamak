use super::{DataSpace, Database, FunctionKind, Json};
use crate::{
    data::{self, Id, Table, Transaction, json_object},
    plugins::Catalog,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

pub(super) const READ: &str = "tokamak:readWindowState";
pub(super) const WRITE: &str = "tokamak:writeWindowState";
const BY_USER_PLUGIN_KEY: &str = "by_user_plugin_key";
const BY_PLUGIN: &str = "by_plugin";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    plugin: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Write {
    plugin: String,
    key: String,
    value: Json,
}

pub(super) async fn call(
    database: &Database,
    catalog: Option<&Catalog>,
    user: &str,
    name: &str,
    kind: Option<FunctionKind>,
    args: Json,
) -> Result<Json, String> {
    // TODO: Bind the plugin identity to its window once each plugin runs in a separate window.
    // In the shared window the authenticated caller supplies the plugin field.
    match (name, kind) {
        (READ, Some(FunctionKind::Query)) => {
            let Read { plugin, key } =
                serde_json::from_value(args).map_err(|_| "Invalid window state read")?;
            let id = record_id(user, &plugin, &key)?;
            let mut tx = database.read_only().await.map_err(storage_error)?;
            let result = tx.get(&id).await;
            tx.rollback().await.map_err(storage_error)?;
            Ok(result.map_err(storage_error)?.map_or(
                Json::Null,
                |row| json!({ "value": row.into_json()["value"] }),
            ))
        }
        (WRITE, Some(FunctionKind::Mutation)) => {
            let Write { plugin, key, value } =
                serde_json::from_value(args).map_err(|_| "Invalid window state write")?;
            let catalog = catalog.ok_or("No plugin catalog loaded")?;
            if !catalog.plugins.contains_key(&plugin) {
                return Err("Plugin is not installed".into());
            }
            let id = record_id(user, &plugin, &key)?;
            let value =
                json_object(&json!({ "user": user, "plugin": plugin, "key": key, "value": value }))
                    .map_err(storage_error)?;
            let mut tx = database.begin().await.map_err(storage_error)?;
            // Both operations need the same transaction: replace requires an existing row,
            // and keyed insert only creates one.
            let result = async {
                if tx.get(&id).await?.is_some() {
                    tx.replace(&id, value).await
                } else {
                    tx.insert_keyed(&id, value).await.map(|_| ())
                }
            }
            .await;
            finish_write(tx, result).await?;
            Ok(Json::Null)
        }
        _ => Err("Window state function kind does not match request".into()),
    }
}

pub(super) async fn initialize(database: &Database, has_catalog: bool) -> Result<(), String> {
    let mut tx = database.begin().await.map_err(storage_error)?;
    let result = async {
        let table = table()?;
        let migration = migration_id()?;
        if tx.get(&migration).await?.is_some() {
            return Ok(());
        }
        // Legacy servers cannot create state anymore. Only initialize their
        // store if there are rows left by an earlier version.
        if !has_catalog && tx.query(&table).limit(1).collect().await?.is_empty() {
            return Ok(());
        }
        // Hash-only rows cannot be attributed to a user or plugin. Drop them
        // before building the unique index, which needs ownership fields.
        for row in tx
            .query(&table)
            .eq("user", data::Value::None)
            .collect()
            .await?
        {
            tx.delete(&row.id).await?;
        }
        tx.define_index(&table, BY_USER_PLUGIN_KEY, &["user", "plugin", "key"], true)
            .await?;
        tx.define_index(&table, BY_PLUGIN, &["plugin"], false)
            .await?;
        tx.insert_keyed(&migration, data::Object::default()).await?;
        Ok(())
    }
    .await;
    finish_write(tx, result).await
}

pub(super) async fn remove_users(database: &Database, users: &[String]) -> Result<(), String> {
    remove_owned(database, users, BY_USER_PLUGIN_KEY, "user").await
}

pub(super) async fn remove_plugins(database: &Database, plugins: &[String]) -> Result<(), String> {
    remove_owned(database, plugins, BY_PLUGIN, "plugin").await
}

async fn remove_owned(
    database: &Database,
    owners: &[String],
    index: &str,
    field: &str,
) -> Result<(), String> {
    if owners.is_empty() {
        return Ok(());
    }
    let table = table().map_err(storage_error)?;
    let mut tx = database.begin().await.map_err(storage_error)?;
    let result = async {
        if tx.get(&migration_id()?).await?.is_none() {
            return Ok(());
        }
        for owner in owners {
            for row in tx
                .query(&table)
                .with_index(index)
                .eq(field, owner.as_str())
                .collect()
                .await?
            {
                tx.delete(&row.id).await?;
            }
        }
        Ok(())
    }
    .await;
    finish_write(tx, result).await
}

async fn finish_write(tx: Transaction, result: data::Result<()>) -> Result<(), String> {
    if let Err(error) = result {
        let error = storage_error(error);
        tx.rollback().await.map_err(storage_error)?;
        return Err(error);
    }
    tx.commit().await.map_err(storage_error)
}

fn table() -> data::Result<Table> {
    DataSpace::plugin("tokamak.host")?.table(&Table::new("window_state")?)
}

fn migration_id() -> data::Result<Id> {
    let meta = DataSpace::plugin("tokamak.host")?.table(&Table::new("window_state_meta")?)?;
    Id::new(meta, "owned_rows")
}

fn record_id(user: &str, plugin: &str, key: &str) -> Result<Id, String> {
    // Bound caller-controlled identifiers before encoding them; compiler keys can
    // be longer than plugin IDs because they include paths and mount sites.
    if plugin.len() > 128
        || DataSpace::plugin(plugin).is_err()
        || key.is_empty()
        || key.len() > 1024
    {
        return Err("Invalid window state key".into());
    }
    let table = table().map_err(storage_error)?;
    let identity =
        serde_json::to_vec(&[user, plugin, key]).map_err(|_| "Invalid window state key")?;
    // The encoded tuple preserves field boundaries; hashing gives it a fixed-size,
    // record-safe key even when a mount key contains punctuation.
    Id::new(table, format!("{:x}", Sha256::digest(identity))).map_err(storage_error)
}

fn storage_error(error: crate::data::Error) -> String {
    eprintln!("Window state storage: {error}");
    "Could not access window state".into()
}
