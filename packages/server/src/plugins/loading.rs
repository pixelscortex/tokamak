use super::*;

impl Loaded {
    pub async fn load(catalog: Catalog, pool: &engine::Pool) -> Result<Arc<Self>, Error> {
        Self::load_reusing(catalog, pool, None).await
    }

    pub async fn load_reusing(
        catalog: Catalog,
        pool: &engine::Pool,
        previous: Option<&Self>,
    ) -> Result<Arc<Self>, Error> {
        let mut targets = BTreeMap::new();

        let mut inspected = BTreeMap::new();

        for id in &catalog.order {
            let artifact = &catalog.plugins[id];

            let Some(bundle) = &artifact.bundle else {
                continue;
            };

            let cached = previous
                .filter(|old| {
                    old.catalog
                        .plugins
                        .get(id)
                        .and_then(|p| p.bundle.as_ref())
                        .is_some_and(|b| Arc::ptr_eq(b, bundle))
                })
                .and_then(|old| old.inspected.get(id));

            let (descriptor, kinds) = match cached {
                Some(value) => value.clone(),
                None => crate::service::inspect(pool, bundle.clone()).await?,
            };
            inspected.insert(id.clone(), (descriptor.clone(), kinds.clone()));

            for name in &artifact.manifest.public_functions {
                if !kinds.contains_key(name) {
                    return Err(invalid(format!(
                        "Exported function {name} is not a backend function of {id}"
                    )));
                }
            }

            for (local_name, kind) in kinds {
                let name = format!("{id}/{local_name}");
                targets.insert(
                    name,
                    Target {
                        owner: id.clone(),
                        local_name,
                        mutation: kind == crate::service::FunctionKind::Mutation,
                        kind,
                        bundle: bundle.clone(),
                        space: DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?,
                    },
                );
            }
        }
        validate_maintenance(&catalog, &targets)?;
        let workers = start_workers(&catalog)?;
        let mut loaded = Self {
            catalog,
            targets,
            descriptor: Value::Null,
            catalog_text: String::new(),
            inspected,
            workers,
        };
        loaded.update_metadata()?;
        Ok(Arc::new(loaded))
    }

    pub(super) fn remove_skipped(&mut self, skipped: &BTreeSet<String>) -> Result<(), Error> {
        self.catalog.plugins.retain(|id, _| !skipped.contains(id));
        self.catalog.order.retain(|id| !skipped.contains(id));
        self.catalog.update_metadata()?;
        self.targets
            .retain(|_, target| !skipped.contains(&target.owner));
        self.workers.retain(|id, _| !skipped.contains(id));
        self.inspected.retain(|id, _| !skipped.contains(id));

        self.update_metadata()
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

fn start_workers(
    catalog: &Catalog,
) -> Result<BTreeMap<String, Arc<crate::host::worker::Supervisor>>, Error> {
    let mut workers = BTreeMap::new();
    for (id, artifact) in &catalog.plugins {
        if let Some(entry) = &artifact.manifest.entries.worker {
            workers.insert(
                id.clone(),
                crate::host::worker::Supervisor::new(
                    id.clone(),
                    artifact.assets[&entry.entry].clone(),
                    artifact.assets[&entry.code].clone(),
                    catalog.directory.join("plugin-data").join(id),
                    &catalog.environment,
                    &artifact.manifest.plugin.permissions,
                )?,
            );
        }
    }

    Ok(workers)
}

fn validate_maintenance(
    catalog: &Catalog,
    targets: &BTreeMap<String, Target>,
) -> Result<(), Error> {
    for (id, artifact) in &catalog.plugins {
        if let Some(name) = &artifact.manifest.plugin.maintenance
            && (artifact.manifest.public_functions.contains(name)
                || targets
                    .get(&format!("{id}/{name}"))
                    .is_none_or(|target| target.kind != crate::service::FunctionKind::Mutation))
        {
            return Err(invalid("Maintenance entry must name a private mutation"));
        }
    }
    Ok(())
}
