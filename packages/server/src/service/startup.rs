use super::*;
use crate::plugins::StartupPolicy;

struct Startup {
    bundle: Option<Arc<Bundle>>,
    legacy_action_bundle: Option<Arc<Bundle>>,
    space: DataSpace,
    descriptor: Json,
    kinds: BTreeMap<String, FunctionKind>,
    single_bundle_private: BTreeSet<String>,
    plugins: Option<Arc<crate::plugins::Loaded>>,
    plugin_root: Option<std::path::PathBuf>,
    quickjs: bool,
}

impl Server {
    pub async fn load(
        database: Database,
        pool: Arc<Pool>,
        bundle: Arc<Bundle>,
    ) -> Result<Self, Error> {
        Self::load_in_space(database, pool, bundle, DataSpace::default()).await
    }

    /// Kernel-selected plugin space. Callers cannot select it in request payloads.
    pub async fn load_in_space(
        mut database: Database,
        pool: Arc<Pool>,
        bundle: Arc<Bundle>,
        space: DataSpace,
    ) -> Result<Self, Error> {
        let quickjs = match quickjs_actions() {
            Ok(quickjs) => quickjs,
            Err(error) => return Err(startup_error(&mut database, error).await),
        };
        let (transactions, legacy_action_bundle) = if quickjs {
            let Some(transactions) = bundle.transactions() else {
                let error = Error::Invalid(
                    "QuickJS actions require a transaction bundle; rebuild the feature".into(),
                );
                return Err(startup_error(&mut database, error).await);
            };
            (transactions, Some(bundle))
        } else {
            (bundle, None)
        };
        let inspected = async {
            let inspected = inspect(&pool, transactions.clone()).await?;

            let schema = crate::schema::Schema::parse(&inspected.descriptor["schema"])?;

            let mut tx = Box::pin(database.begin())
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?;

            match Box::pin(schema.apply(&mut tx, &space, true)).await {
                Ok(reset) => {
                    Box::pin(tx.commit())
                        .await
                        .map_err(|e| Error::Invalid(e.to_string()))?;
                    if let Some(reason) = reset {
                        crate::schema::log_reset(&reason);
                    }
                }
                Err(error) => {
                    Box::pin(tx.rollback()).await.map_err(|e| {
                        Error::Invalid(format!("{error}; schema rollback failed: {e}"))
                    })?;

                    return Err(error);
                }
            }

            Ok(inspected)
        }
        .await;

        let InspectedBundle {
            mut descriptor,
            kinds,
            visibility,
        } = match inspected {
            Ok(inspected) => inspected,
            Err(error) => {
                return Err(startup_error(&mut database, error).await);
            }
        };
        let single_bundle_private: BTreeSet<_> = visibility
            .into_iter()
            .filter_map(|(name, visibility)| (visibility != Visibility::Public).then_some(name))
            .collect();
        // The single-bundle action bridge needs every kind for nested calls;
        // the client descriptor and routing must still omit internal functions.
        descriptor["functions"]
            .as_array_mut()
            .expect("inspected")
            .retain(|function| {
                !single_bundle_private.contains(function["name"].as_str().expect("inspected"))
            });
        Self::start(
            database,
            pool,
            Startup {
                bundle: Some(transactions),
                legacy_action_bundle,
                space,
                descriptor,
                kinds,
                single_bundle_private,
                plugins: None,
                plugin_root: None,
                quickjs,
            },
        )
        .await
    }

    /// All static manifests resolve before any plugin module is evaluated.
    pub async fn load_plugins(
        database: Database,
        pool: Arc<Pool>,
        root: &std::path::Path,
    ) -> Result<Self, Error> {
        Self::load_plugin_catalog(database, pool, root, StartupPolicy::Strict).await
    }

    pub(crate) async fn load_plugin_catalog(
        mut database: Database,
        pool: Arc<Pool>,
        root: &std::path::Path,
        policy: StartupPolicy,
    ) -> Result<Self, Error> {
        let quickjs = match quickjs_actions() {
            Ok(quickjs) => quickjs,
            Err(error) => return Err(startup_error(&mut database, error).await),
        };
        let loaded =
            match crate::plugins::Catalog::read_at_startup(root, database.directory(), quickjs) {
                Ok(catalog) => crate::plugins::Loaded::load(catalog, &pool, policy, quickjs).await,
                Err(error) => Err(error),
            };

        let loaded = match loaded {
            Ok(mut loaded) => {
                async {
                    Box::pin(loaded.record_startup_grants(&database)).await?;
                    Ok(Arc::new(loaded))
                }
                .await
            }
            Err(error) => Err(error),
        };

        let loaded = match loaded {
            Ok(loaded) => loaded,
            Err(error) => {
                return Err(startup_error(&mut database, error).await);
            }
        };

        let kinds = loaded.client_kinds();
        Self::start(
            database,
            pool,
            Startup {
                bundle: None,
                legacy_action_bundle: None,
                space: DataSpace::default(),
                descriptor: loaded.descriptor.clone(),
                kinds,
                single_bundle_private: BTreeSet::new(),
                plugins: Some(loaded),
                plugin_root: Some(root.to_owned()),
                quickjs,
            },
        )
        .await
    }

    async fn start(
        mut database: Database,
        pool: Arc<Pool>,
        startup: Startup,
    ) -> Result<Self, Error> {
        let Startup {
            bundle,
            legacy_action_bundle,
            space,
            descriptor,
            kinds,
            single_bundle_private,
            plugins,
            plugin_root,
            quickjs,
        } = startup;
        let state = async {
            Box::pin(window_state::initialize(&database, plugins.is_some()))
                .await
                .map_err(Error::Invalid)?;
            if let Some(loaded) = &plugins {
                Box::pin(window_state::remove_plugins(
                    &database,
                    &loaded.catalog.removed_plugins,
                ))
                .await
                .map_err(Error::Invalid)?;
                loaded.catalog.persist_install_order(database.directory())?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = state {
            return Err(startup_error(&mut database, error).await);
        }
        let ActionStartup {
            action_pool,
            action_process,
            legacy_action_source,
        } = match ActionStartup::new(quickjs, &pool, legacy_action_bundle.as_ref(), &kinds) {
            Ok(startup) => startup,
            Err(error) => return Err(startup_error(&mut database, error).await),
        };

        let changes = database.subscribe(); // Before any initial subscription run.
        let (commands, receiver) = mpsc::channel(COMMANDS);

        let (closing, close_receiver) = mpsc::channel(1);

        let cleanup = Arc::new(Notify::new());

        let (closed_sender, closed) = watch::channel(None);

        let actor = Coordinator {
            database,
            pool,
            bundle,
            kinds,
            single_bundle_private,
            space,
            plugins,
            plugin_root,
            changes,
            action_pool,
            action_process,
            legacy_action_source,
            sign_in_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            sign_in_pool: None,
            action_jobs: tokio::task::JoinSet::new(),
            commands: commands.downgrade(),
            sessions: BTreeMap::new(),
            next_session: 0,
            cleanup: cleanup.clone(),
            closed: closed_sender,
        };
        // Owning the task, rather than a caller future, shields accepted calls
        // through COMMIT, invalidation, and ordered delivery. Client cancellation
        // does not abort finalization. Process/runtime failure remains unknown.
        tokio::spawn(actor.run(receiver, close_receiver));

        Ok(Self {
            commands,
            closing,
            descriptor,
            cleanup,
            closed,
        })
    }
}

#[derive(Clone)]
pub(crate) struct InspectedBundle {
    pub descriptor: Json,
    pub kinds: BTreeMap<String, FunctionKind>,
    pub visibility: BTreeMap<String, Visibility>,
}

pub(crate) async fn inspect(pool: &Pool, bundle: Arc<Bundle>) -> Result<InspectedBundle, Error> {
    let descriptor = pool
        .submit(
            bundle.clone(),
            "describe",
            Json::Null,
            Arc::new(OpRegistry::new()),
        )
        .map_err(|e| Error::Invalid(e.to_string()))?
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;

    let mut kinds = BTreeMap::new();
    let mut visibility = BTreeMap::new();

    for function in descriptor
        .get("functions")
        .and_then(Json::as_array)
        .ok_or_else(|| Error::Invalid("bundle descriptor must list functions".into()))?
    {
        let name = function
            .get("name")
            .and_then(Json::as_str)
            .ok_or_else(|| Error::Invalid("invalid function name".into()))?;
        visibility.insert(name.to_owned(), Visibility::from_descriptor(function)?);

        let kind = FunctionKind::from_wire(&function["kind"]).ok_or_else(|| {
            Error::Invalid("function kind must be query, mutation or action".into())
        })?;

        if kinds.insert(name.to_owned(), kind).is_some() {
            return Err(Error::Invalid("duplicate function name".into()));
        }
    }

    if descriptor.get("schema").is_none() {
        return Err(Error::Invalid(
            "bundle descriptor must include schema".into(),
        ));
    }
    crate::schema::Schema::parse(&descriptor["schema"])?;

    Ok(InspectedBundle {
        descriptor,
        kinds,
        visibility,
    })
}

async fn startup_error(database: &mut Database, error: Error) -> Error {
    match Box::pin(database.close()).await {
        Ok(()) => error,
        Err(close) => Error::Invalid(format!("{error}; startup cleanup failed: {close}")),
    }
}

fn quickjs_actions() -> Result<bool, Error> {
    tokamak_worker::LocalRuntime::selected()
        .map(|runtime| runtime == tokamak_worker::LocalRuntime::QuickJs)
        .map_err(Error::Invalid)
}

struct ActionStartup {
    action_pool: Option<Arc<Pool>>,
    action_process: Option<Arc<crate::host::action_process::Supervisor>>,
    legacy_action_source: Option<Arc<crate::host::action_process::Source>>,
}

impl ActionStartup {
    fn new(
        quickjs: bool,
        pool: &Pool,
        bundle: Option<&Arc<Bundle>>,
        kinds: &BTreeMap<String, FunctionKind>,
    ) -> Result<Self, Error> {
        if quickjs {
            let host = tokamak_worker::Process::action_host_path().map_err(Error::Invalid)?;
            let heap = tokamak_worker::configured_heap_bytes("TOKAMAK_ACTION_HEAP_MIB")
                .map_err(Error::Invalid)?;
            let legacy_action_source = bundle
                .filter(|_| kinds.values().any(|kind| *kind == FunctionKind::Action))
                .map(|bundle| crate::host::action_process::Source::legacy(bundle.clone()))
                .transpose()?;
            return Ok(Self {
                action_pool: None,
                action_process: Some(crate::host::action_process::Supervisor::new(host, heap)),
                legacy_action_source,
            });
        }

        let pool = Pool::new_actions(PoolConfig {
            limits: pool.limits().clone(),
            ..PoolConfig::default()
        })
        .map_err(|error| Error::Invalid(error.to_string()))?;
        Ok(Self {
            action_pool: Some(Arc::new(pool)),
            action_process: None,
            legacy_action_source: None,
        })
    }
}
