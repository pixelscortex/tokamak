use super::{ActionContext, Loaded, OpRegistry, RunnerSlot, Supervisor, operations};
use crate::{
    identity::CallNote,
    plugins::{
        ContractDeclaration, ContractPlace, ContractRegistration, LocalDataMethods, Manifest,
    },
    service::Command,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct RunnerActionUpstream {
    pub ops: Arc<OpRegistry>,
    scope: Option<Box<Scope>>,
    environment: Arc<crate::ActionEnvironment>,
}

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
}

impl RunnerActionUpstream {
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
            })
        });
        Self {
            ops,
            scope,
            environment,
        }
    }

    pub fn redact(&self, error: String) -> String {
        self.environment.redact(error)
    }

    pub fn local_contracts(&self, payload: &Value) -> Result<Value, String> {
        let scope = self.scope.as_ref().ok_or("Missing plugin scope")?;
        let declaration = scope.declaration(payload)?;
        let catalog = &scope.generation.catalog;
        let mut providers = Vec::new();
        for plugin in &catalog.order {
            let manifest = &catalog.plugins[plugin].manifest;
            let registrations: Vec<_> = scope.registrations(manifest, &declaration.name).collect();
            if !registrations
                .iter()
                .all(|entry| entry.declaration_hash == declaration.declaration_hash)
            {
                providers.push(json!({"plugin":plugin, "incompatible":true}));
                continue;
            }
            let Some((entry, code)) = runner_hashes(manifest) else {
                continue;
            };
            for registration in registrations {
                let mut provider = json!({
                    "plugin":plugin,
                    "owner":scope.owner,
                    "own":plugin == &scope.owner,
                    "registration":registration.registration,
                    "build":format!("{entry}:{code}"),
                });
                if let Some(reason) = &registration.unavailable {
                    provider["unavailable"] = json!(reason);
                }
                providers.push(provider);
            }
        }
        Ok(Value::Array(providers))
    }

    pub fn local_contract(
        &self,
        label: &str,
        payload: &Value,
    ) -> Result<RunnerContractRoute, String> {
        let scope = self.scope.as_ref().ok_or("Missing plugin scope")?;
        let invalid = || "Invalid local contract route".to_owned();
        let declaration = scope.declaration(payload)?;
        let plugin = payload["plugin"].as_str().ok_or_else(invalid)?;
        let manifest = &scope
            .generation
            .catalog
            .plugins
            .get(plugin)
            .ok_or_else(invalid)?
            .manifest;
        let registration = payload["registration"].as_str().ok_or_else(invalid)?;
        let mut providers = scope.registrations(manifest, &declaration.name);
        if !providers
            .clone()
            .any(|candidate| candidate.registration == registration)
            || !providers
                .all(|candidate| candidate.declaration_hash == declaration.declaration_hash)
        {
            return Err(invalid());
        }
        let (entry_hash, code_hash) = runner_hashes(manifest).ok_or_else(invalid)?;
        let note = scope
            .note
            .enter(label, None, &payload["args"])
            .map_err(|error| error.to_string())?;
        let environment = Arc::new(crate::environment::Snapshot::new(
            Some(&scope.generation),
            Some(plugin),
        ));
        let upstream = operations(
            scope.commands.clone(),
            Some(scope.generation.clone()),
            Some(plugin.to_owned()),
            environment,
            scope.process.clone(),
            ActionContext {
                note,
                runner: scope.runner.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        Ok(RunnerContractRoute {
            entry_hash: entry_hash.to_owned(),
            code_hash: code_hash.to_owned(),
            upstream,
        })
    }
}

impl Scope {
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
            .find(|entry| entry.name == name && entry.place == ContractPlace::Local)
            .ok_or_else(|| format!("Unknown local contract: {}/{name}", self.owner))?;
        if !matches!(declaration.data_methods, Some(LocalDataMethods::All(true))) {
            return Err("QuickJS local contracts require dataMethods: true".into());
        }
        Ok(declaration)
    }

    fn registrations<'a>(
        &'a self,
        manifest: &'a Manifest,
        name: &'a str,
    ) -> impl Iterator<Item = &'a ContractRegistration> + Clone {
        manifest.contract_providers.iter().filter(move |entry| {
            manifest.plugin.declares_access_to(&self.owner)
                && entry.owner == self.owner
                && entry.name == name
                && entry.place == ContractPlace::Local
        })
    }
}

pub(super) fn runner_hashes(manifest: &Manifest) -> Option<(&str, &str)> {
    let local = manifest.entries.local.as_ref()?;
    Some((
        manifest.hashes.get(&local.entry)?,
        manifest.hashes.get(&local.code)?,
    ))
}
