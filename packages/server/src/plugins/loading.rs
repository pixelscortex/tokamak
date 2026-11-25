use tokio::task::JoinSet;

use super::*;
use crate::{
    host::action_process::Source,
    service::{FunctionKind, InspectedBundle},
};

const ACTION_INSPECTIONS: usize = 8;

struct Prepared {
    server: Option<PreparedServer>,
}

struct PreparedServer {
    bundle: Arc<Bundle>,
    inspected: InspectedBundle,
    space: DataSpace,
    source: Option<Arc<Source>>,
    inspect_source: bool,
}

impl Prepared {
    async fn check_actions(self) -> Result<Self, Error> {
        if let Some(server) = &self.server
            && server.inspect_source
            && let Some(source) = &server.source
        {
            source.inspect().await?;
        }
        Ok(self)
    }
}

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
        Self::load_with_policy(catalog, pool, None, policy, None).await
    }

    pub async fn load_reusing(
        catalog: Catalog,
        pool: &engine::Pool,
        previous: Option<&Self>,
        reloaded: &str,
    ) -> Result<Self, Error> {
        Self::load_with_policy(
            catalog,
            pool,
            previous,
            StartupPolicy::Strict,
            Some(reloaded),
        )
        .await
    }

    async fn load_with_policy(
        catalog: Catalog,
        pool: &engine::Pool,
        previous: Option<&Self>,
        policy: StartupPolicy,
        reloaded: Option<&str>,
    ) -> Result<Self, Error> {
        let mut loaded = Self {
            catalog,
            targets: BTreeMap::new(),
            hooks: BTreeMap::new(),
            transaction_bundles: BTreeMap::new(),
            descriptor: Value::Null,
            catalog_text: String::new(),
            inspected: BTreeMap::new(),
            contracts: BTreeMap::new(),
            action_sources: BTreeMap::new(),
            skipped: BTreeMap::new(),
        };
        if reloaded.is_none() {
            let mut checked = Self::check_startup_actions(&loaded.catalog, pool).await?;
            for (index, id) in loaded.catalog.order.clone().into_iter().enumerate() {
                let prepared = checked.remove(&index).expect("plugin preparation result");
                loaded.apply_plugin(id, prepared, policy, previous)?;
            }
        } else {
            for id in loaded.catalog.order.clone() {
                if let Some(reason) = loaded.skipped_dependency(&id) {
                    loaded.skip(id, reason);
                    continue;
                }
                let prepared = Self::prepare_plugin(
                    &loaded.catalog,
                    &id,
                    pool,
                    previous,
                    reloaded == Some(id.as_str()),
                )
                .await;
                let prepared = match prepared {
                    Ok(prepared) => prepared.check_actions().await,
                    Err(error) => Err(error),
                };
                loaded.apply_plugin(id, prepared, policy, previous)?;
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
        loaded.register_hooks()?;
        loaded.update_metadata()?;
        Ok(loaded)
    }

    async fn check_startup_actions(
        catalog: &Catalog,
        pool: &engine::Pool,
    ) -> Result<BTreeMap<usize, Result<Prepared, Error>>, Error> {
        let mut checks = JoinSet::new();
        let mut ordered = BTreeMap::new();
        // Describe transactions serially through the server's pool, while
        // independent action inspections run in separate processes.
        for (index, id) in catalog.order.iter().enumerate() {
            if checks.len() == ACTION_INSPECTIONS
                && let Some(result) = checks.join_next().await
            {
                let (index, prepared) =
                    result.map_err(|error: tokio::task::JoinError| invalid(error.to_string()))?;
                ordered.insert(index, prepared);
            }

            match Self::prepare_plugin(catalog, id, pool, None, false).await {
                Ok(prepared) => {
                    checks.spawn(async move { (index, prepared.check_actions().await) });
                }
                Err(error) => {
                    ordered.insert(index, Err(error));
                }
            }
        }
        while let Some(result) = checks.join_next().await {
            let (index, prepared) = result.map_err(|error| invalid(error.to_string()))?;
            ordered.insert(index, prepared);
        }
        Ok(ordered)
    }

    async fn prepare_plugin(
        catalog: &Catalog,
        id: &str,
        pool: &engine::Pool,
        previous: Option<&Self>,
        reloaded: bool,
    ) -> Result<Prepared, Error> {
        let artifact = &catalog.plugins[id];
        let unchanged = previous.filter(|old| {
            old.catalog.plugins.get(id).is_some_and(|old| {
                old.manifest.hashes == artifact.manifest.hashes
                    && serde_json::to_value(&old.manifest).ok()
                        == serde_json::to_value(&artifact.manifest).ok()
            })
        });
        let server = if let Some(bundle) = artifact.transactions().await? {
            let cached = unchanged.and_then(|old| old.inspected.get(id));
            let inspected = match cached {
                Some(value) => value.clone(),
                None => crate::service::inspect(pool, bundle.clone()).await?,
            };
            validate_exports(id, &artifact.manifest, &inspected)?;
            validate_maintenance(artifact, Some(&inspected.kinds))?;
            let space = DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
            let (source, inspect_source) = if inspected
                .kinds
                .values()
                .any(|kind| *kind == FunctionKind::Action)
            {
                let prior = unchanged
                    .filter(|_| !reloaded)
                    .and_then(|old| old.action_sources.get(id));
                match prior {
                    Some(source) => (Some(source.clone()), false),
                    None => (Some(artifact.action_source(id)?), true),
                }
            } else {
                (None, false)
            };
            Some(PreparedServer {
                bundle,
                inspected,
                space,
                source,
                inspect_source,
            })
        } else {
            validate_maintenance(artifact, None)?;
            None
        };
        Ok(Prepared { server })
    }

    fn apply_plugin(
        &mut self,
        id: String,
        prepared: Result<Prepared, Error>,
        policy: StartupPolicy,
        previous: Option<&Self>,
    ) -> Result<(), Error> {
        if let Some(reason) = self.skipped_dependency(&id) {
            self.skip(id, reason);
            return Ok(());
        }

        let Prepared { server } = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                if policy == StartupPolicy::Strict
                    && !previous.is_some_and(|old| old.skipped.contains_key(&id))
                {
                    return Err(error);
                }
                self.skip(id, error.to_string());
                return Ok(());
            }
        };
        if let Some(PreparedServer {
            bundle,
            inspected,
            space,
            source,
            ..
        }) = server
        {
            for function in inspected.descriptor["functions"]
                .as_array()
                .expect("inspected")
            {
                let local_name = function["name"].as_str().expect("inspected");
                let kind = inspected.kinds[local_name];
                let name = format!("{id}/{local_name}");
                self.targets.insert(
                    name,
                    Target {
                        owner: id.clone(),
                        local_name: local_name.to_owned(),
                        args: Arc::new(
                            source
                                .as_ref()
                                .and_then(|source| source.validator(local_name))
                                .unwrap_or(&function["args"])
                                .clone(),
                        ),
                        result: inspected.descriptor["results"]
                            .get(local_name)
                            .map(|validator| Arc::new(validator.clone())),
                        mutation: kind == FunctionKind::Mutation,
                        visibility: inspected.visibility[local_name],
                        kind,
                        bundle: bundle.clone(),
                        space: space.clone(),
                    },
                );
            }
            if let Some(source) = source {
                self.action_sources.insert(id.clone(), source);
            }
            self.transaction_bundles.insert(id.clone(), bundle);
            self.inspected.insert(id.clone(), inspected);
        }
        Ok(())
    }

    pub(super) fn prune_skipped(&mut self) -> Result<(), Error> {
        if self.skipped.is_empty() {
            return Ok(());
        }
        self.remove_skipped()?;
        self.contracts = self.load_contracts().map_err(|failure| failure.error)?;
        self.register_hooks()?;
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
        self.action_sources
            .retain(|id, _| !skipped.contains_key(id));
        self.inspected.retain(|id, _| !skipped.contains_key(id));
        self.transaction_bundles
            .retain(|id, _| !skipped.contains_key(id));
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

    fn register_hooks(&mut self) -> Result<(), Error> {
        self.hooks.clear();

        for (owner, inspected) in &self.inspected {
            let Some(hooks) = inspected.descriptor.get("hooks") else {
                continue;
            };
            let hooks = hooks
                .as_array()
                .ok_or_else(|| invalid("Expected a list of hooks"))?;
            if hooks.is_empty() {
                continue;
            }

            let bundle = &self.transaction_bundles[owner];
            let space = DataSpace::plugin(owner).map_err(|error| invalid(error.to_string()))?;

            for hook in hooks {
                let name = hook["name"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing hook name"))?;
                let target = hook["target"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing hook target"))?;
                let before = hook["before"]
                    .as_bool()
                    .ok_or_else(|| invalid("Invalid before stage"))?;
                let after = hook["after"]
                    .as_bool()
                    .ok_or_else(|| invalid("Invalid after stage"))?;
                if !before && !after {
                    continue;
                }
                let Some((target_owner, _)) = target.split_once('/') else {
                    return Err(invalid(format!(
                        "Hook {owner}/{name} must target another plugin"
                    )));
                };
                if target_owner == owner {
                    return Err(invalid(format!(
                        "Hook {owner}/{name} must target another plugin"
                    )));
                }
                let Some(function) = self.targets.get(target) else {
                    eprintln!("Skipping hook {owner}/{name}: target {target} is missing");
                    continue;
                };

                if function.kind != FunctionKind::Query || function.visibility != Visibility::Public
                {
                    eprintln!(
                        "Skipping hook {owner}/{name}: target {target} is no longer a public query"
                    );
                    continue;
                }

                self.hooks.entry(target.to_owned()).or_default().push(Hook {
                    owner: owner.clone(),
                    name: name.to_owned(),
                    before,
                    after,
                    bundle: bundle.clone(),
                    space: space.clone(),
                });
            }
        }

        Ok(())
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

    pub(crate) fn same_action_source(&self, previous: &Self, plugin: &str) -> bool {
        self.action_sources
            .get(plugin)
            .zip(previous.action_sources.get(plugin))
            .is_some_and(|(current, previous)| Arc::ptr_eq(current, previous))
    }

    pub(crate) fn same_plugin(&self, previous: &Self, plugin: &str) -> bool {
        self.catalog
            .plugins
            .get(plugin)
            .zip(previous.catalog.plugins.get(plugin))
            .is_some_and(|(current, previous)| {
                serde_json::to_value(&current.manifest).ok()
                    == serde_json::to_value(&previous.manifest).ok()
            })
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
        contract: Option<&str>,
    ) -> Result<Target, String> {
        let target = self.action_target(caller, name, contract)?;
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

fn validate_exports(
    id: &str,
    manifest: &Manifest,
    inspected: &crate::service::InspectedBundle,
) -> Result<(), Error> {
    for name in &manifest.public_functions {
        let explanation = match inspected.visibility.get(name) {
            Some(Visibility::Public) => continue,
            Some(Visibility::Internal) => "is internal and cannot be exported",
            Some(Visibility::PluginOnly) => "is plugin-only and cannot be exported to windows",
            None => "is not a backend function",
        };
        return Err(invalid(format!("Function {id}/{name} {explanation}")));
    }
    for name in &manifest.plugin_functions {
        if inspected.visibility.get(name) != Some(&Visibility::PluginOnly) {
            return Err(invalid(format!("Missing plugin-only function {id}/{name}")));
        }
    }
    Ok(())
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
