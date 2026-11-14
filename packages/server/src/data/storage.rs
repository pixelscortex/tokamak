//! The storage owner has no query engine, node bootstrap, or maintenance loop.
//! Catalog IDs are resolved once at open; every application operation afterwards
//! shares its caller's storage transaction and snapshot.
use std::sync::Arc;
use surrealdb_datastore::{
    factory::TransactionFactory, sequences::Sequences, triggers::CommitTriggers,
};
use surrealdb_idx::catalog::{DatabaseId, NamespaceId, providers::DatabaseProvider};
use surrealdb_kvs::TransactionType;

pub(super) struct StorageCore {
    pub factory: TransactionFactory,
    pub sequences: Sequences,
    pub ns: NamespaceId,
    pub db: DatabaseId,
    pub config: surrealdb_idx::config::IdxConfig,
    pub stores: surrealdb_idx::trees::store::IndexStores,
    pub node: uuid::Uuid,
}

impl StorageCore {
    pub async fn open(path: &str) -> anyhow::Result<Self> {
        let builder = surrealdb_kvs_any::Backends::community()
            .new_transaction_builder(path, Default::default(), Default::default())
            .await?;
        let factory = TransactionFactory::new(
            Arc::new(CommitTriggers::new()),
            builder,
            Arc::new(Default::default()),
        );
        let node = uuid::Uuid::new_v4();
        let sequences = Sequences::new(factory.clone(), node);
        let config = surrealdb_idx::config::IdxConfig::default();
        let stores = surrealdb_idx::trees::store::IndexStores::new(
            config.hnsw_cache_size,
            config.diskann_cache_size,
            config.graph_resolve_cache_size,
            config.fulltext_cache_size,
            config.segment_dictionary_path.clone(),
        );
        let setup = async {
            let tx = factory
                .transaction(TransactionType::Write, sequences.clone())
                .await?;
            let database = tx
                .get_or_add_db_upwards(None, "tokamak", "tokamak", true)
                .await?;
            tx.commit().await?;
            anyhow::Ok((database.namespace_id, database.database_id))
        }
        .await;
        match setup {
            Ok((ns, db)) => Ok(Self {
                factory,
                sequences,
                ns,
                db,
                node,
                config,
                stores,
            }),
            Err(error) => {
                // A failed open must release the disk lock too. Retain both
                // errors when cleanup fails, because a retry may encounter it.
                match factory.shutdown().await {
                    Ok(()) => Err(error),
                    Err(cleanup) => {
                        Err(error.context(format!("startup cleanup failed: {cleanup}")))
                    }
                }
            }
        }
    }
}

/// Only scalar b-tree indexes are exposed, but IndexOperation requires this
/// environment even when no analyzer, vector tree, or compaction is used.
pub(super) struct IndexContext<'a> {
    pub tx: Arc<surrealdb_datastore::Transaction>,
    pub core: &'a StorageCore,
}
impl surrealdb_idx::catalog::providers::CancellationProbe for IndexContext<'_> {
    fn expect_not_timedout(
        &self,
    ) -> surrealdb_idx::catalog::providers::BoxProviderFut<'_, anyhow::Result<()>> {
        Box::pin(async { Ok(()) })
    }
}
impl surrealdb_idx::env::IndexEnv for IndexContext<'_> {
    fn tx(&self) -> Arc<surrealdb_datastore::Transaction> {
        self.tx.clone()
    }
    fn is_done(&self, _: Option<usize>) -> surrealdb_idx::env::BoxEnvFut<'_> {
        Box::pin(async { Ok(false) })
    }
    fn index_stores(&self) -> &surrealdb_idx::trees::store::IndexStores {
        &self.core.stores
    }
    fn node_id(&self) -> uuid::Uuid {
        self.core.node
    }
    fn sequences(&self) -> anyhow::Result<&Sequences> {
        Ok(&self.core.sequences)
    }
    fn config(&self) -> &surrealdb_idx::config::IdxConfig {
        &self.core.config
    }
    fn places(&self) -> surrealdb_idx::places::Ticket {
        surrealdb_idx::places::Ticket::serial()
    }
}
pub(super) struct NoAnalyzer;
impl surrealdb_idx::ft::analyzer::AnalyzerFunction for NoAnalyzer {
    fn call<'a>(
        &'a self,
        _: &'a str,
        _: surrealdb_idx::val::Strand,
    ) -> surrealdb_idx::ft::analyzer::BoxAnalyzerFut<'a> {
        Box::pin(async { anyhow::bail!("TokamakDB does not support analyzer functions") })
    }
}
