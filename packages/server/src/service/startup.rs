use super::*;

struct Startup {
    bundle: Option<Arc<Bundle>>,
    space: DataSpace,
    descriptor: Json,
    kinds: BTreeMap<String, FunctionKind>,
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
        let inspected = async {
            let inspected = inspect(&pool, bundle.clone()).await?;

            let schema = crate::schema::Schema::parse(&inspected.0["schema"])?;

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

        let (descriptor, kinds) = match inspected {
            Ok(inspected) => inspected,
            Err(error) => {
                return Err(startup_error(&mut database, error).await);
            }
        };
        Self::start(
            database,
            pool,
            Startup {
                bundle: Some(bundle),
                space,
                descriptor,
                kinds,
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
        Self::load_plugins_with_index(database, pool, root, None).await
    }

    pub(crate) async fn load_plugins_with_index(
        mut database: Database,
        pool: Arc<Pool>,
        root: &std::path::Path,
        index: Option<&std::path::Path>,
    ) -> Result<Self, Error> {
        let directory = database
            .directory()
            .unwrap_or(root.parent().unwrap_or(root));
        let loaded =
            crate::plugins::Loaded::startup(root, directory, index, &pool, &database).await;

        let loaded = match loaded {
            Ok(loaded) => loaded,
            Err(error) => {
                return Err(startup_error(&mut database, error).await);
            }
        };

        loaded.publish(None, &loaded.changed_plugins(None)).await;
        for log in loaded.logs.values() {
            log.published().await;
        }
        let kinds = loaded.client_kinds();
        Self::start(
            database,
            pool,
            Startup {
                bundle: None,
                space: DataSpace::default(),
                descriptor: loaded.descriptor.clone(),
                kinds,
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
            space,
            descriptor,
            kinds,
            plugins,
            plugin_root,
        } = startup;
        let action_pool = match Pool::new_actions(PoolConfig {
            limits: pool.limits().clone(),
            ..PoolConfig::default()
        }) {
            Ok(pool) => Arc::new(pool),
            Err(error) => {
                return Err(startup_error(&mut database, Error::Invalid(error.to_string())).await);
            }
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
            space,
            plugins,
            plugin_root,
            window_reports: BTreeMap::new(),
            changes,
            action_pool,
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

pub(crate) async fn inspect(
    pool: &Pool,
    bundle: Arc<Bundle>,
) -> Result<(Json, BTreeMap<String, FunctionKind>), Error> {
    inspect_with_ops(pool, bundle, OpRegistry::new()).await
}

pub(crate) async fn inspect_with_ops(
    pool: &Pool,
    bundle: Arc<Bundle>,
    ops: OpRegistry,
) -> Result<(Json, BTreeMap<String, FunctionKind>), Error> {
    let descriptor = pool
        .submit(bundle.clone(), "describe", Json::Null, Arc::new(ops))
        .map_err(|e| Error::Invalid(e.to_string()))?
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;

    let mut kinds = BTreeMap::new();

    for function in descriptor
        .get("functions")
        .and_then(Json::as_array)
        .ok_or_else(|| Error::Invalid("bundle descriptor must list functions".into()))?
    {
        let name = function
            .get("name")
            .and_then(Json::as_str)
            .ok_or_else(|| Error::Invalid("invalid function name".into()))?;

        let mutation = match function.get("kind").and_then(Json::as_str) {
            Some("query") => FunctionKind::Query,
            Some("mutation") => FunctionKind::Mutation,
            Some("action") => FunctionKind::Action,
            _ => {
                return Err(Error::Invalid(
                    "function kind must be query, mutation or action".into(),
                ));
            }
        };

        if kinds.insert(name.to_owned(), mutation).is_some() {
            return Err(Error::Invalid("duplicate function name".into()));
        }
    }

    if descriptor.get("schema").is_none() {
        return Err(Error::Invalid(
            "bundle descriptor must include schema".into(),
        ));
    }
    crate::schema::Schema::parse(&descriptor["schema"])?;

    Ok((descriptor, kinds))
}

async fn startup_error(database: &mut Database, error: Error) -> Error {
    match Box::pin(database.close()).await {
        Ok(()) => error,
        Err(close) => Error::Invalid(format!("{error}; startup cleanup failed: {close}")),
    }
}
