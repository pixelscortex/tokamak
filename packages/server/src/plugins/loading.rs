use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartupPolicy {
    Strict,
    Recover,
}

impl Loaded {
    pub async fn load(
        catalog: Catalog,
        pool: &engine::Pool,
        policy: StartupPolicy,
    ) -> Result<Self, Error> {
        Self::load_with_policy(catalog, pool, None, policy).await
    }

    pub async fn load_reusing(
        catalog: Catalog,
        pool: &engine::Pool,
        previous: Option<&Self>,
    ) -> Result<Self, Error> {
        Self::load_with_policy(catalog, pool, previous, StartupPolicy::Strict).await
    }

    async fn load_with_policy(
        catalog: Catalog,
        pool: &engine::Pool,
        previous: Option<&Self>,
        policy: StartupPolicy,
    ) -> Result<Self, Error> {
        let mut loaded = Self {
            catalog,
            targets: BTreeMap::new(),
            descriptor: Value::Null,
            catalog_text: String::new(),
            inspected: BTreeMap::new(),
            contracts: BTreeMap::new(),
            workers: BTreeMap::new(),
            skipped: BTreeMap::new(),
        };
        for id in loaded.catalog.order.clone() {
            if let Some(reason) = loaded.skipped_dependency(&id) {
                loaded.skip(id, reason);
                continue;
            }
            if let Err(error) = loaded.prepare_plugin(&id, pool, previous).await {
                if policy == StartupPolicy::Strict
                    && !previous.is_some_and(|old| old.skipped.contains_key(&id))
                {
                    return Err(error);
                }
                loaded.skip(id, error.to_string());
            }
        }
        loaded.remove_skipped()?;
        loaded.contracts = loop {
            match loaded.load_contracts() {
                Ok(contracts) => break contracts,
                Err(failure) => {
                    let Some(id) = failure.auth_provider.filter(|id| {
                        policy == StartupPolicy::Recover
                            || previous.is_some_and(|old| old.skipped.contains_key(id))
                    }) else {
                        return Err(failure.error);
                    };
                    // An invalid auth registration must not stop recovery or
                    // force existing devices to sign in again.
                    loaded.skip(id, failure.error.to_string());
                    loaded.skip_dependents();
                    loaded.remove_skipped()?;
                }
            }
        };
        loaded.update_metadata()?;
        Ok(loaded)
    }

    async fn prepare_plugin(
        &mut self,
        id: &str,
        pool: &engine::Pool,
        previous: Option<&Self>,
    ) -> Result<(), Error> {
        let artifact = &self.catalog.plugins[id];
        let worker = prepare_worker(&self.catalog, id, artifact)?;
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
            let inspected = match cached {
                Some(value) => value.clone(),
                None => crate::service::inspect(pool, bundle.clone()).await?,
            };
            for name in &artifact.manifest.public_functions {
                let explanation = match inspected.visibility.get(name) {
                    Some(Visibility::Public) => continue,
                    Some(Visibility::Internal) => "is internal and cannot be exported",
                    Some(Visibility::PluginOnly) => {
                        "is plugin-only and cannot be exported to windows"
                    }
                    None => "is not a backend function",
                };
                return Err(invalid(format!("Function {id}/{name} {explanation}")));
            }
            for name in &artifact.manifest.plugin_functions {
                if inspected.visibility.get(name) != Some(&Visibility::PluginOnly) {
                    return Err(invalid(format!("Missing plugin-only function {id}/{name}")));
                }
            }
            validate_maintenance(artifact, Some(&inspected.kinds))?;
            let space = DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
            for (local_name, kind) in &inspected.kinds {
                let name = format!("{id}/{local_name}");
                self.targets.insert(
                    name,
                    Target {
                        owner: id.to_owned(),
                        local_name: local_name.clone(),
                        mutation: *kind == crate::service::FunctionKind::Mutation,
                        visibility: inspected.visibility[local_name],
                        kind: *kind,
                        bundle: bundle.clone(),
                        space: space.clone(),
                    },
                );
            }
            self.inspected.insert(id.to_owned(), inspected);
        } else {
            validate_maintenance(artifact, None)?;
        }
        if let Some(worker) = worker {
            self.workers.insert(id.to_owned(), worker);
        }
        Ok(())
    }

    pub(super) fn prune_skipped(&mut self) -> Result<(), Error> {
        if self.skipped.is_empty() {
            return Ok(());
        }
        self.remove_skipped()?;
        self.contracts = self.load_contracts().map_err(|failure| failure.error)?;
        self.update_metadata()
    }

    fn remove_skipped(&mut self) -> Result<(), Error> {
        if self.skipped.is_empty() {
            return Ok(());
        }
        let skipped = &self.skipped;
        self.catalog
            .plugins
            .retain(|id, _| !skipped.contains_key(id));
        self.catalog.order.retain(|id| !skipped.contains_key(id));
        self.catalog.update_metadata()?;
        self.targets
            .retain(|_, target| !skipped.contains_key(&target.owner));
        self.workers.retain(|id, _| !skipped.contains_key(id));
        self.inspected.retain(|id, _| !skipped.contains_key(id));
        Ok(())
    }

    pub(super) fn skip_dependents(&mut self) {
        for id in self.catalog.order.clone() {
            if !self.skipped.contains_key(&id)
                && let Some(reason) = self.skipped_dependency(&id)
            {
                self.skip(id, reason);
            }
        }
    }

    pub(super) fn skipped_dependency(&self, id: &str) -> Option<String> {
        self.catalog.plugins[id]
            .manifest
            .plugin
            .depends
            .keys()
            .find(|dependency| self.skipped.contains_key(*dependency))
            .map(|dependency| format!("requires {dependency}, which did not load"))
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
            .map(|(id, inspected)| (id, &inspected.descriptor["schema"]))
            .collect();
        let functions: Vec<_> = self
            .catalog
            .order
            .iter()
            .filter_map(|id| self.inspected.get(id).map(|inspected| (id, inspected)))
            .flat_map(|(id, inspected)| {
                client_descriptors(
                    id,
                    inspected,
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

    pub fn client_kinds(&self) -> BTreeMap<String, crate::service::FunctionKind> {
        self.targets
            .iter()
            .filter(|(_, target)| {
                target.visibility == Visibility::Public && !self.scheduler_only(target)
            })
            .map(|(name, target)| (name.clone(), target.kind))
            .collect()
    }

    pub(super) fn scheduler_only(&self, target: &Target) -> bool {
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
        contract: Option<&str>,
    ) -> Result<Target, String> {
        let target = self.action_target(caller, name, path, contract)?;
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
        contract: Option<&str>,
    ) -> Result<Target, String> {
        let target = self
            .targets
            .get(name)
            .ok_or_else(|| format!("Unknown plugin function: {name}"))?;

        if self.scheduler_only(target) {
            return Err(format!("Unknown plugin function: {name}"));
        }
        if let Some(contract) = contract {
            if !self.is_contract_method(caller, contract, name) {
                return Err(format!("Unknown contract method: {name}"));
            }
        } else if !self.catalog.can_call(caller, &target.owner) {
            return Err(format!(
                "{caller} does not declare access to {}",
                target.owner
            ));
        }

        let manifest = &self.catalog.plugins[&target.owner].manifest;

        if contract.is_none() && caller != target.owner {
            let exported = manifest.plugin.exports.is_some()
                && match target.visibility {
                    Visibility::Public => manifest.public_functions.contains(&target.local_name),
                    Visibility::PluginOnly => {
                        manifest.plugin_functions.contains(&target.local_name)
                            && self.catalog.plugins[caller]
                                .manifest
                                .plugin
                                .declares_access_to(&target.owner)
                    }
                    Visibility::Internal => false,
                };
            if !exported {
                return Err(format!(
                    "{} is not exported by {}",
                    target.local_name, target.owner
                ));
            }
        }

        if path.len() >= 16 || path.iter().any(|entry| entry == name) {
            return Err("Plugin call cycle".into());
        }

        Ok(target.clone())
    }
}

fn client_descriptors(
    id: &str,
    inspected: &crate::service::InspectedBundle,
    maintenance: Option<&str>,
) -> Vec<Value> {
    inspected.descriptor["functions"]
        .as_array()
        .expect("inspected")
        .iter()
        .filter_map(|function| {
            let name = function["name"].as_str().expect("inspected");
            if maintenance == Some(name) || inspected.visibility[name] != Visibility::Public {
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
            || artifact.manifest.plugin_functions.contains(name)
            || kinds.and_then(|kinds| kinds.get(name))
                != Some(&crate::service::FunctionKind::Mutation))
    {
        return Err(invalid("Maintenance entry must name a private mutation"));
    }
    Ok(())
}
