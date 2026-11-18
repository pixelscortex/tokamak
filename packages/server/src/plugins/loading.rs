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

        let mut functions = Vec::new();

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

            for mut function in descriptor["functions"]
                .as_array()
                .expect("inspected")
                .clone()
            {
                function["name"] =
                    format!("{id}/{}", function["name"].as_str().expect("inspected")).into();
                functions.push(function);
            }
        }
        // Keep logical table names scoped by plugin in the aggregate metadata.
        let schemas: BTreeMap<_, _> = inspected
            .iter()
            .map(|(id, (descriptor, _))| (id.clone(), descriptor["schema"].clone()))
            .collect();

        let descriptor = json!({"schema":schemas,"functions":functions});

        let mut metadata = catalog.metadata();
        metadata["functions"] = descriptor["functions"].clone();
        metadata["schema"] = descriptor["schema"].clone();

        let catalog_text = serde_json::to_string(&metadata).map_err(|e| invalid(e.to_string()))?;

        validate_maintenance(&catalog, &targets)?;
        let workers = start_workers(&catalog)?;
        Ok(Arc::new(Self {
            catalog,
            targets,
            descriptor,
            catalog_text,
            inspected,
            workers,
        }))
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
            && targets
                .get(&format!("{id}/{name}"))
                .is_none_or(|target| target.kind != crate::service::FunctionKind::Mutation)
        {
            return Err(invalid("Maintenance entry must name a mutation"));
        }
    }
    Ok(())
}
