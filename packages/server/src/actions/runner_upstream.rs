use super::{
    ActionContext, Loaded, OpRegistry, RunnerSlot, Supervisor, current_plugins, operations,
};
use crate::{
    identity::CallNote,
    plugins::{
        ContractDeclaration, ContractTarget, LocalDataMethods, Manifest, runner_provider_routes,
    },
    service::Command,
};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;

pub(crate) struct ActionOperations {
    pub ops: Arc<OpRegistry>,
    scope: Option<Box<Scope>>,
    environment: Arc<crate::ActionEnvironment>,
}

pub struct RunnerActionUpstream(pub(super) ActionOperations);

pub struct RunnerContractRoute {
    pub entry_hash: String,
    pub code_hash: String,
    pub upstream: RunnerActionUpstream,
}

struct Scope {
    owner: String,
    generation: Arc<Loaded>,
    commands: mpsc::WeakSender<Command>,
    process: Arc<Supervisor>,
    note: CallNote,
    runner: Arc<RunnerSlot>,
    lifetime: Option<tokio_util::sync::CancellationToken>,
}

impl ActionOperations {
    pub(super) fn new(
        ops: Arc<OpRegistry>,
        generation: Option<Arc<Loaded>>,
        owner: Option<String>,
        commands: mpsc::WeakSender<Command>,
        process: Arc<Supervisor>,
        context: ActionContext,
        environment: Arc<crate::ActionEnvironment>,
    ) -> Self {
        let scope = generation.zip(owner).map(|(generation, owner)| {
            Box::new(Scope {
                owner,
                generation,
                commands,
                process,
                note: context.note,
                runner: context.runner,
                lifetime: context.lifetime,
            })
        });
        Self {
            ops,
            scope,
            environment,
        }
    }
}
impl RunnerActionUpstream {
    pub fn operations(&self) -> &OpRegistry {
        &self.0.ops
    }

    pub fn redact(&self, error: String) -> String {
        self.0.environment.redact(error)
    }

    pub async fn local_contracts(&self, payload: &Value) -> Result<Value, String> {
        let scope = self.0.scope.as_ref().ok_or("Missing plugin scope")?;
        let declaration = scope.declaration(payload)?;
        let current = scope.current().await?;
        let mut providers = if scope.compatible_declaration(&current, declaration) {
            current
                .catalog
                .runner_contract_providers(&scope.owner, declaration)
        } else {
            Vec::new()
        };
        let own = runner_provider_routes(
            &scope.generation.catalog.plugins[&scope.owner].manifest,
            &scope.owner,
            declaration,
        );
        let index = providers
            .iter()
            .position(|route| route["plugin"] == scope.owner);
        providers.retain(|route| route["plugin"] != scope.owner);
        providers.splice(index.unwrap_or(0)..index.unwrap_or(0), own);
        Ok(Value::Array(providers))
    }

    pub async fn local_contract(
        &self,
        label: &str,
        payload: &Value,
    ) -> Result<RunnerContractRoute, String> {
        let scope = self.0.scope.as_ref().ok_or("Missing plugin scope")?;
        let invalid = || "Invalid local contract route".to_owned();
        let declaration = scope.declaration(payload)?;
        let plugin = payload["plugin"].as_str().ok_or_else(invalid)?;
        let current = scope.current().await?;
        let generation = if plugin == scope.owner {
            &scope.generation
        } else if scope.compatible_declaration(&current, declaration) {
            &current
        } else {
            return Err(invalid());
        };
        let manifest = scope
            .provider_manifest(&current, plugin)
            .ok_or_else(invalid)?;
        let registration = payload["registration"].as_str().ok_or_else(invalid)?;
        if !runner_provider_routes(manifest, &scope.owner, declaration)
            .iter()
            .any(|route| route["registration"] == registration)
        {
            return Err(invalid());
        }
        let (entry_hash, code_hash) = runner_hashes(manifest).ok_or_else(invalid)?;
        let note = scope
            .note
            .enter(label, None, &payload["args"])
            .map_err(|error| error.to_string())?;
        let environment = Arc::new(crate::environment::Snapshot::new(
            Some(generation),
            Some(plugin),
        ));
        let upstream = operations(
            scope.commands.clone(),
            Some(generation.clone()),
            Some(plugin.to_owned()),
            environment,
            scope.process.clone(),
            ActionContext {
                note,
                runner: scope.runner.clone(),
                lifetime: scope.lifetime.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        Ok(RunnerContractRoute {
            entry_hash: entry_hash.to_owned(),
            code_hash: code_hash.to_owned(),
            upstream: RunnerActionUpstream(upstream),
        })
    }
}

impl Scope {
    async fn current(&self) -> Result<Arc<Loaded>, String> {
        current_plugins(
            &self.commands,
            self.lifetime.as_ref().ok_or("Missing Runner scope")?,
        )
        .await
    }

    fn compatible_declaration(&self, current: &Loaded, declaration: &ContractDeclaration) -> bool {
        current
            .catalog
            .plugins
            .get(&self.owner)
            .is_some_and(|plugin| {
                plugin.manifest.contracts.iter().any(|key| {
                    key.on == ContractTarget::Caller
                        && key.name == declaration.name
                        && key.declaration_hash == declaration.declaration_hash
                })
            })
    }

    fn provider_manifest<'a>(&'a self, current: &'a Loaded, plugin: &str) -> Option<&'a Manifest> {
        let loaded = if plugin == self.owner {
            &self.generation
        } else {
            current
        };
        Some(&loaded.catalog.plugins.get(plugin)?.manifest)
    }

    fn declaration(&self, payload: &Value) -> Result<&ContractDeclaration, String> {
        if payload
            .get("owner")
            .is_some_and(|owner| owner.as_str() != Some(&self.owner))
        {
            return Err("Only the defining plugin can list contract providers".into());
        }
        let name = payload["name"].as_str().ok_or("Missing contract name")?;
        let declaration = self.generation.catalog.plugins[&self.owner]
            .manifest
            .contracts
            .iter()
            .find(|entry| entry.name == name && entry.on == ContractTarget::Caller)
            .ok_or_else(|| format!("Unknown local contract: {}/{name}", self.owner))?;
        if !matches!(declaration.data_methods, Some(LocalDataMethods::All(true))) {
            return Err("QuickJS local contracts require dataMethods: true".into());
        }
        Ok(declaration)
    }
}

pub(crate) fn runner_hashes(manifest: &Manifest) -> Option<(&str, &str)> {
    let local = manifest.entries.local.as_ref()?;
    Some((
        manifest.hashes.get(&local.entry)?,
        manifest.hashes.get(&local.code)?,
    ))
}
