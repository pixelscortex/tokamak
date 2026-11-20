use super::{
    catalog::{IndexedArtifacts, installed_paths, read_index, read_installed},
    *,
};

impl Loaded {
    pub async fn startup(
        root: &Path,
        directory: &Path,
        index: Option<&Path>,
        pool: &engine::Pool,
        database: &crate::data::Database,
    ) -> Result<Arc<Self>, Error> {
        let (installed, _) = read_installed(root, None)?;
        let candidates = read_index(index);
        let config = StartupCatalog {
            root,
            directory,
            pool,
            database,
            index_path: index,
        };
        let loaded = match config.commit(&installed, &candidates, None).await {
            Ok(loaded) => loaded,
            Err(error) if candidates.is_empty() => return Err(error),
            Err(_) => config.recover(&installed, candidates).await?,
        };
        for (id, folder) in loaded.catalog.index.iter() {
            if installed.contains_key(id) {
                eprintln!(
                    "Indexed plugin {id} at {} replaces the copy from --plugins",
                    folder.display()
                );
            }
        }
        Ok(Arc::new(loaded))
    }

    #[cfg(test)]
    pub async fn load(catalog: Catalog, pool: &engine::Pool) -> Result<Self, Error> {
        Self::load_reusing(catalog, BTreeMap::new(), pool, None).await
    }

    pub async fn load_reusing(
        catalog: Catalog,
        artifact_failures: BTreeMap<String, String>,
        pool: &engine::Pool,
        previous: Option<&Self>,
    ) -> Result<Self, Error> {
        let mut loaded = Self {
            catalog,
            targets: BTreeMap::new(),
            descriptor: Value::Null,
            catalog_text: String::new(),
            inspected: BTreeMap::new(),
            workers: BTreeMap::new(),
            skipped: BTreeMap::new(),
            action_lifetimes: BTreeMap::new(),
            current: previous.map(|old| old.current.clone()).unwrap_or_default(),
        };
        for (id, reason) in artifact_failures {
            loaded.skip(id, reason);
        }
        for id in loaded.catalog.order.clone() {
            if loaded.skip_if_required_dependency_failed(&id, previous)? {
                continue;
            }
            if let Err(error) = loaded.prepare_plugin(&id, pool, previous).await {
                if !previous.is_some_and(|old| old.skipped.contains_key(&id)) {
                    return Err(error);
                }
                loaded.skip(id, error.to_string());
            }
        }
        if loaded.skipped.is_empty() {
            loaded.update_metadata()?;
        } else {
            loaded.prune_skipped()?;
        }
        Ok(loaded)
    }

    async fn prepare_plugin(
        &mut self,
        id: &str,
        pool: &engine::Pool,
        previous: Option<&Self>,
    ) -> Result<(), Error> {
        let artifact = &self.catalog.plugins[id];
        let unchanged = previous.filter(|old| self.catalog.same_build(&old.catalog, id));
        let worker = match unchanged {
            Some(old) => old.workers.get(id).cloned(),
            None => prepare_worker(&self.catalog, id, artifact)?,
        };
        if let Some(bundle) = &artifact.bundle {
            let cached = previous
                .filter(|old| {
                    old.catalog
                        .plugins
                        .get(id)
                        .and_then(|p| p.bundle.as_ref())
                        .is_some_and(|old| Arc::ptr_eq(old, bundle))
                })
                .and_then(|old| old.inspected.get(id));
            let (descriptor, kinds) = match cached {
                Some(value) => value.clone(),
                None => crate::service::inspect(pool, bundle.clone()).await?,
            };
            for name in &artifact.manifest.public_functions {
                if !kinds.contains_key(name) {
                    return Err(invalid(format!(
                        "Exported function {name} is not a server function of {id}"
                    )));
                }
            }
            validate_maintenance(artifact, Some(&kinds))?;
            let space = DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
            for (local_name, kind) in &kinds {
                let name = format!("{id}/{local_name}");
                self.targets.insert(
                    name,
                    Target {
                        owner: id.to_owned(),
                        local_name: local_name.clone(),
                        mutation: *kind == crate::service::FunctionKind::Mutation,
                        kind: *kind,
                        bundle: bundle.clone(),
                        space: space.clone(),
                    },
                );
            }
            self.inspected.insert(id.to_owned(), (descriptor, kinds));
        } else {
            validate_maintenance(artifact, None)?;
        }
        if let Some(worker) = worker {
            self.workers.insert(id.to_owned(), worker);
        }
        let lifetime = unchanged
            .map(|old| old.action_lifetimes[id].clone())
            .unwrap_or_default();
        self.action_lifetimes.insert(id.to_owned(), lifetime);
        Ok(())
    }

    pub(super) fn prune_skipped(&mut self) -> Result<(), Error> {
        if self.skipped.is_empty() {
            return Ok(());
        }
        let skipped = &self.skipped;
        self.catalog.omit_skipped(skipped)?;
        self.targets
            .retain(|_, target| !skipped.contains_key(&target.owner));
        self.workers.retain(|id, _| !skipped.contains_key(id));
        self.action_lifetimes
            .retain(|id, _| !skipped.contains_key(id));
        self.inspected.retain(|id, _| !skipped.contains_key(id));
        self.update_metadata()
    }

    pub(super) fn skip_if_required_dependency_failed(
        &mut self,
        id: &str,
        previous: Option<&Self>,
    ) -> Result<bool, Error> {
        let Some(dependency) = self.catalog.plugins[id]
            .manifest
            .plugin
            .depends
            .keys()
            .find(|dependency| self.skipped.contains_key(*dependency))
        else {
            return Ok(false);
        };
        let reason = format!("requires {dependency}, which did not load");
        if previous.is_some_and(|old| old.catalog.plugins.contains_key(id)) {
            return Err(invalid(format!(
                "Cannot reload active plugin {id}: {reason}"
            )));
        }
        self.skip(id.to_owned(), reason);
        Ok(true)
    }

    pub(super) fn skip(&mut self, id: String, reason: String) {
        eprintln!("Skipping plugin {id}: {reason}");
        self.skipped.insert(id, reason);
    }

    fn update_metadata(&mut self) -> Result<(), Error> {
        // Keep logical table names scoped by plugin in the aggregate metadata.
        let schemas: BTreeMap<_, _> = self
            .inspected
            .iter()
            .map(|(id, (descriptor, _))| (id, &descriptor["schema"]))
            .collect();
        let functions: Vec<_> = self
            .catalog
            .order
            .iter()
            .filter_map(|id| {
                self.inspected
                    .get(id)
                    .map(|(descriptor, _)| (id, descriptor))
            })
            .flat_map(|(id, descriptor)| {
                client_descriptors(
                    id,
                    descriptor,
                    self.catalog.plugins[id]
                        .manifest
                        .plugin
                        .maintenance
                        .as_deref(),
                )
            })
            .collect();
        self.descriptor = json!({"schema":schemas,"functions":functions});
        let mut metadata = self.catalog.metadata();
        metadata["functions"] = self.descriptor["functions"].clone();
        metadata["schema"] = self.descriptor["schema"].clone();
        self.catalog_text = serde_json::to_string(&metadata).map_err(|e| invalid(e.to_string()))?;
        Ok(())
    }

    pub(super) async fn check_worker(&self, id: &str) -> Result<(), Error> {
        if let Some(worker) = self.workers.get(id) {
            worker.check_ready().await.map_err(|error| {
                let environment = crate::environment::Snapshot::new(Some(self), Some(id));
                invalid(format!(
                    "Plugin {id} worker failed readiness: {}",
                    environment.redact(error)
                ))
            })?;
        }
        Ok(())
    }

    pub(crate) fn changed_plugins(&self, previous: Option<&Self>) -> BTreeSet<String> {
        let Some(old) = previous else {
            return self.catalog.plugins.keys().cloned().collect();
        };
        self.catalog
            .plugins
            .keys()
            .chain(
                old.catalog
                    .plugins
                    .keys()
                    .filter(|id| !self.catalog.plugins.contains_key(*id)),
            )
            .filter(|id| !self.catalog.same_build(&old.catalog, id))
            .cloned()
            .collect()
    }

    pub(crate) async fn publish(
        self: &Arc<Self>,
        previous: Option<&Self>,
        changed: &BTreeSet<String>,
    ) {
        // Action calls can resolve outside the coordinator. Block them during
        // retirement so a new worker cannot use the live directory until its
        // predecessor has stopped.
        let mut current = self.current.write().await;
        if let Some(previous) = previous {
            for id in changed {
                if let Some(lifetime) = previous.action_lifetimes.get(id) {
                    lifetime.cancel();
                }
            }
            for id in changed {
                if let Some(worker) = previous.workers.get(id) {
                    worker.stop().await;
                }
            }
        }
        *current = Arc::downgrade(self);
    }

    pub(crate) async fn current_for(&self, caller: &str) -> Result<Arc<Self>, String> {
        let current = self.current.read().await;
        if self.action_lifetimes[caller].is_cancelled() {
            return Err("Plugin action cancelled by reload".into());
        }
        current.upgrade().ok_or_else(|| "server is closed".into())
    }

    pub fn client_kinds(&self) -> BTreeMap<String, crate::service::FunctionKind> {
        self.targets
            .iter()
            .filter(|(_, target)| !self.scheduler_only(target))
            .map(|(name, target)| (name.clone(), target.kind))
            .collect()
    }

    fn scheduler_only(&self, target: &Target) -> bool {
        self.catalog.plugins[&target.owner]
            .manifest
            .plugin
            .maintenance
            .as_deref()
            == Some(&target.local_name)
    }

    pub fn target(
        &self,
        caller: &str,
        name: &str,
        writable: bool,
        path: &[String],
    ) -> Result<Target, String> {
        let target = self.action_target(caller, name, path)?;
        if target.kind == crate::service::FunctionKind::Action {
            return Err("Queries and mutations cannot call actions".into());
        }
        if target.mutation && !writable {
            return Err("Queries cannot call mutations".into());
        }
        Ok(target)
    }

    /// Actions may delegate to exported functions with the target's own grants.
    pub fn action_target(
        &self,
        caller: &str,
        name: &str,
        path: &[String],
    ) -> Result<Target, String> {
        let target = self
            .targets
            .get(name)
            .ok_or_else(|| format!("Unknown plugin function: {name}"))?;

        if self.scheduler_only(target) {
            return Err(format!("Unknown plugin function: {name}"));
        }
        if !self.catalog.can_call(caller, &target.owner) {
            return Err(format!(
                "{caller} does not declare access to {}",
                target.owner
            ));
        }

        let manifest = &self.catalog.plugins[&target.owner].manifest;

        if caller != target.owner
            && (manifest.plugin.exports.is_none()
                || !manifest.public_functions.contains(&target.local_name))
        {
            return Err(format!(
                "{} is not exported by {}",
                target.local_name, target.owner
            ));
        }

        if path.len() >= 16 || path.iter().any(|entry| entry == name) {
            return Err("Plugin call cycle".into());
        }

        Ok(target.clone())
    }
}

fn client_descriptors(id: &str, descriptor: &Value, maintenance: Option<&str>) -> Vec<Value> {
    descriptor["functions"]
        .as_array()
        .expect("inspected")
        .iter()
        .filter_map(|function| {
            let name = function["name"].as_str().expect("inspected");
            if maintenance == Some(name) {
                return None;
            }
            let mut function = function.clone();
            function["name"] = format!("{id}/{name}").into();
            Some(function)
        })
        .collect()
}

fn prepare_worker(
    catalog: &Catalog,
    id: &str,
    artifact: &Artifact,
) -> Result<Option<Arc<crate::host::worker::Supervisor>>, Error> {
    let Some(entry) = &artifact.manifest.entries.worker else {
        return Ok(None);
    };
    crate::host::worker::Supervisor::new(
        id.to_owned(),
        artifact.assets[&entry.entry].clone(),
        artifact.assets[&entry.code].clone(),
        catalog.directory.join("plugin-data").join(id),
        &catalog.environment,
        &artifact.manifest.plugin.permissions,
    )
    .map(Some)
}

fn validate_maintenance(
    artifact: &Artifact,
    kinds: Option<&BTreeMap<String, crate::service::FunctionKind>>,
) -> Result<(), Error> {
    if let Some(name) = &artifact.manifest.plugin.maintenance
        && (artifact.manifest.public_functions.contains(name)
            || kinds.and_then(|kinds| kinds.get(name))
                != Some(&crate::service::FunctionKind::Mutation))
    {
        return Err(invalid("Maintenance entry must name a private mutation"));
    }
    Ok(())
}

struct StartupCatalog<'a> {
    root: &'a Path,
    directory: &'a Path,
    pool: &'a engine::Pool,
    database: &'a crate::data::Database,
    index_path: Option<&'a Path>,
}

impl StartupCatalog<'_> {
    async fn load(
        &self,
        installed: &BTreeMap<String, Arc<Artifact>>,
        indexed: &IndexedArtifacts,
        previous: Option<&Loaded>,
    ) -> Result<Loaded, Error> {
        let mut plugins = installed.clone();
        let index = indexed
            .iter()
            .map(|(id, (folder, artifact))| {
                plugins.insert(id.clone(), Arc::clone(artifact));
                (id.clone(), folder.clone())
            })
            .collect();
        let mut catalog = Catalog::assemble(self.root, self.directory, plugins, Arc::new(index))?;
        catalog.installed = installed_paths(installed);
        catalog.index_path = self.index_path.map(Path::to_owned);
        Loaded::load_reusing(catalog, BTreeMap::new(), self.pool, previous).await
    }

    async fn commit(
        &self,
        installed: &BTreeMap<String, Arc<Artifact>>,
        indexed: &IndexedArtifacts,
        previous: Option<&Loaded>,
    ) -> Result<Loaded, Error> {
        let mut loaded = self.load(installed, indexed, previous).await?;
        Box::pin(loaded.record_startup_grants(self.database)).await?;
        Ok(loaded)
    }

    async fn trial(
        &self,
        installed: &BTreeMap<String, Arc<Artifact>>,
        indexed: &IndexedArtifacts,
        previous: &Loaded,
    ) -> Result<Loaded, Error> {
        let loaded = self.load(installed, indexed, Some(previous)).await?;
        // Run the same schema and grant checks as startup without publishing a
        // partially accepted generation or making persistent changes.
        Box::pin(loaded.check_startup_grants(self.database)).await?;
        Ok(loaded)
    }

    async fn recover(
        &self,
        installed: &BTreeMap<String, Arc<Artifact>>,
        mut pending: IndexedArtifacts,
    ) -> Result<Loaded, Error> {
        let mut accepted = BTreeMap::new();
        let mut loaded = self.load(installed, &accepted, None).await?;
        let mut failures = BTreeMap::new();
        // Retry failed candidates after a successful pass: a dependency may
        // have been accepted later in the order. Keep each installed fallback
        // until its replacement has passed the complete loading pipeline.
        loop {
            let remaining = pending.len();
            for (id, entry) in std::mem::take(&mut pending) {
                accepted.insert(id.clone(), entry.clone());
                match self.trial(installed, &accepted, &loaded).await {
                    Ok(next) => loaded = next,
                    Err(error) => {
                        accepted.remove(&id);
                        pending.insert(id.clone(), entry);
                        failures.insert(id, error);
                    }
                }
            }
            if pending.is_empty() || pending.len() == remaining {
                break;
            }
        }
        let mut loaded = self.commit(installed, &accepted, Some(&loaded)).await?;
        for (id, (folder, _)) in pending {
            if let Some(error) = failures.get(&id) {
                eprintln!(
                    "Skipping indexed plugin {id} at {}: {error}",
                    folder.display()
                );
                if !loaded.catalog.plugins.contains_key(&id) {
                    Arc::make_mut(&mut loaded.catalog.index).insert(id.clone(), folder);
                    loaded.skipped.insert(id, error.to_string());
                }
            }
        }
        Ok(loaded)
    }
}
