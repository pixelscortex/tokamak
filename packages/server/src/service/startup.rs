use super::*;
use crate::{host::action_process::Source, plugins::StartupPolicy};

struct Startup {
    bundle: Option<Arc<Bundle>>,
    legacy_action_source: Option<Arc<Source>>,
    space: DataSpace,
    descriptor: Json,
    kinds: BTreeMap<String, FunctionKind>,
    single_bundle_private: BTreeSet<String>,
    plugins: Option<Arc<crate::plugins::Loaded>>,
    plugin_root: Option<std::path::PathBuf>,
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
        let Some(transactions) = bundle.transactions() else {
            let error = Error::Invalid(
                "QuickJS actions require a transaction bundle; rebuild the feature".into(),
            );
            return Err(startup_error(&mut database, error).await);
        };
        let inspected = async {
            let inspected = inspect(&pool, transactions.clone()).await?;

            let legacy_action_source = if inspected
                .kinds
                .values()
                .any(|kind| *kind == FunctionKind::Action)
            {
                let source = Source::legacy(bundle)?;
                source.inspect().await?;
                Some(source)
            } else {
                None
            };
            initialize_standalone_schema(&mut database, &space, &inspected.descriptor).await?;
            Ok((inspected, legacy_action_source))
        }
        .await;

        let (
            InspectedBundle {
                mut descriptor,
                kinds,
                visibility,
            },
            legacy_action_source,
        ) = match inspected {
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
                legacy_action_source,
                space,
                descriptor,
                kinds,
                single_bundle_private,
                plugins: None,
                plugin_root: None,
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
        let loaded = match crate::plugins::Catalog::read_at_startup(root, database.directory()) {
            Ok(catalog) => crate::plugins::Loaded::load(catalog, &pool, policy).await,
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
                legacy_action_source: None,
                space: DataSpace::default(),
                descriptor: loaded.descriptor.clone(),
                kinds,
                single_bundle_private: BTreeSet::new(),
                plugins: Some(loaded),
                plugin_root: Some(root.to_owned()),
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
            legacy_action_source,
            space,
            descriptor,
            kinds,
            single_bundle_private,
            plugins,
            plugin_root,
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
        let action_process = match action_startup() {
            Ok(process) => process,
            Err(error) => return Err(startup_error(&mut database, error).await),
        };

        let changes = database.subscribe(); // Before any initial subscription run.
        let (commands, receiver) = mpsc::channel(COMMANDS);

        let (closing, close_receiver) = mpsc::channel(1);

        let cleanup = Arc::new(Notify::new());

        let (closed_sender, closed) = watch::channel(None);

        let runner = Arc::new(crate::actions::Machines::default());
        runner
            .update_plugins(plugins.clone())
            .map_err(|error| Error::Invalid(error.to_string()))?;
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
            action_process,
            legacy_action_source,
            runner: runner.clone(),
            action_jobs: tokio::task::JoinSet::new(),
            action_cancellations: BTreeMap::new(),
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
            runner,
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

        if let Some(on) = function.get("on")
            && (kind != FunctionKind::Action
                || serde_json::from_value::<ActionTarget>(on.clone()).is_err())
        {
            return Err(Error::Invalid("Invalid action target".into()));
        }

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

async fn initialize_standalone_schema(
    database: &mut Database,
    space: &DataSpace,
    descriptor: &Json,
) -> Result<(), Error> {
    let schema = crate::schema::Schema::parse(&descriptor["schema"])?;

    let mut tx = Box::pin(database.begin())
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;

    match Box::pin(schema.apply(&mut tx, space, true)).await {
        Ok(reset) => {
            Box::pin(tx.commit())
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?;
            if let Some(reason) = reset {
                crate::schema::log_reset(&reason);
            }
        }
        Err(error) => {
            Box::pin(tx.rollback())
                .await
                .map_err(|e| Error::Invalid(format!("{error}; schema rollback failed: {e}")))?;

            return Err(error);
        }
    }
    Ok(())
}

fn action_startup() -> Result<Option<Arc<crate::host::action_process::Supervisor>>, Error> {
    if tokamak_worker::require_plugin_platform(std::env::consts::OS).is_err() {
        return Ok(None);
    }
    let host = tokamak_worker::Process::action_host_path().map_err(Error::Invalid)?;
    let heap = tokamak_worker::configured_action_heap_bytes().map_err(Error::Invalid)?;
    Ok(Some(crate::host::action_process::Supervisor::new(
        host, heap,
    )))
}
