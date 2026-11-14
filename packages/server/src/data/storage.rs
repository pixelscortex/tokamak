//! The storage owner has no query engine, node bootstrap, or maintenance loop.
//! Catalog IDs are resolved once at open; every application operation afterwards
//! shares its caller's storage transaction and snapshot.
use std::sync::Arc;
use surrealdb_datastore::{factory::TransactionFactory, sequences::Sequences, triggers::CommitTriggers};
use surrealdb_idx::catalog::{DatabaseId, NamespaceId, providers::DatabaseProvider};
use surrealdb_kvs::TransactionType;

pub(super) struct StorageCore {
    pub factory: TransactionFactory,
    pub sequences: Sequences,
    pub ns: NamespaceId,
    pub db: DatabaseId,
}

impl StorageCore {
    pub async fn open(path: &str) -> anyhow::Result<Self> {
        let builder = surrealdb_kvs_any::Backends::community()
            .new_transaction_builder(path, Default::default(), Default::default()).await?;
        let factory = TransactionFactory::new(Arc::new(CommitTriggers::new()), builder, Arc::new(Default::default()));
        let sequences = Sequences::new(factory.clone(), uuid::Uuid::new_v4());
        let setup = async {
            let tx = factory.transaction(TransactionType::Write, sequences.clone()).await?;
            let database = tx.get_or_add_db_upwards(None, "tokamak", "tokamak", true).await?;
            tx.commit().await?;
            anyhow::Ok((database.namespace_id, database.database_id))
        }.await;
        match setup {
            Ok((ns, db)) => Ok(Self { factory, sequences, ns, db }),
            Err(error) => {
                // A failed open must release the disk lock too. Retain both
                // errors when cleanup fails, because a retry may encounter it.
                match factory.shutdown().await {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(error.context(format!("startup cleanup failed: {cleanup}"))),
                }
            }
        }
    }
}
