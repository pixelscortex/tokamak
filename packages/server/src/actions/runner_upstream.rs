use super::{ActionContext, Loaded, Machines, OpRegistry, Supervisor, current_plugins, operations};
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
    pub(super) scope: Option<Box<Scope>>,
    environment: Arc<crate::ActionEnvironment>,
}

pub struct RunnerActionUpstream(Upstream);

enum Upstream {
    Embedded(ActionOperations),
    Connected {
        peer: crate::machine_wire::Peer,
        root: u64,
        scope: u64,
    },
}

pub struct RunnerContractRoute {
    pub entry_hash: String,
    pub code_hash: String,
    pub upstream: RunnerActionUpstream,
}

#[derive(Clone)]
pub(super) struct Scope {
    pub(super) owner: String,
    pub(super) generation: Arc<Loaded>,
    pub(super) commands: mpsc::WeakSender<Command>,
    pub(super) process: Arc<Supervisor>,
    pub(super) note: CallNote,
    pub(super) runner: Arc<Machines>,
    pub(super) lifetime: Option<tokio_util::sync::CancellationToken>,
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
    pub(super) fn embedded(ops: ActionOperations) -> Self {
        Self(Upstream::Embedded(ops))
    }

    pub fn is_connected(&self) -> bool {
        matches!(self.0, Upstream::Connected { .. })
    }

    pub fn connected(peer: crate::machine_wire::Peer, root: u64) -> Self {
        Self(Upstream::Connected {
            peer,
            root,
            scope: 0,
        })
    }

    async fn request(&self, name: &str, payload: Value) -> Result<Value, String> {
        let Upstream::Connected { peer, root, scope } = &self.0 else {
            return Err("Expected connected Runner scope".into());
        };
        let id = peer.next_id();
        peer.call(
            id,
            crate::machine_wire::Request::Operation {
                root: *root,
                scope: *scope,
                name: name.to_owned(),
                payload,
            },
        )
        .await
        .map_err(|error| engine::CallError::from(error).message)
    }

    pub async fn dispatch(&self, name: &str, payload: Value) -> Result<Value, engine::CallError> {
        match &self.0 {
            Upstream::Embedded(ops) => ops.ops.dispatch_call(name, payload).await,
            Upstream::Connected { .. } => {
                let value = self.request(name, payload).await?;
                if let Some(error) = value.get("error") {
                    if let Some(message) = error.as_str() {
                        return Err(message.into());
                    }
                    return Err(engine::CallError {
                        message: "Server operation failed".into(),
                        details: Some(error.clone()),
                        limit: None,
                        kind: None,
                    });
                }
                Ok(value["value"].clone())
            }
        }
    }

    pub(crate) fn redact_call_error(&self, error: engine::CallError) -> engine::CallError {
        let limit = error.limit.clone();
        let kind = error.kind;
        let mut error = engine::CallError::from(
            crate::protocol::CallError::from(error).map_text(|text| self.redact(text)),
        );
        error.limit = limit;
        error.kind = kind;
        error
    }

    pub fn redact(&self, error: String) -> String {
        match &self.0 {
            Upstream::Embedded(ops) => ops.environment.redact(error),
            Upstream::Connected { .. } => error,
        }
    }

    pub async fn local_contracts(&self, payload: &Value) -> Result<Value, String> {
        let Upstream::Embedded(ops) = &self.0 else {
            return self.request("local.contracts", payload.clone()).await;
        };
        let scope = ops.scope.as_ref().ok_or("Missing plugin scope")?;
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
        let ops = match &self.0 {
            Upstream::Embedded(ops) => ops,
            Upstream::Connected { peer, root, .. } => {
                let request = serde_json::json!({"label": label, "args": payload});
                let route = self.request("local.contract.route", request).await?;
                let hash = |key: &str| {
                    route[key]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or("Missing contract artifact hash")
                };
                return Ok(RunnerContractRoute {
                    entry_hash: hash("entryHash")?,
                    code_hash: hash("codeHash")?,
                    upstream: Self(Upstream::Connected {
                        peer: peer.clone(),
                        root: *root,
                        scope: route["scope"].as_u64().ok_or("Missing contract scope")?,
                    }),
                });
            }
        };
        let scope = ops.scope.as_ref().ok_or("Missing plugin scope")?;
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
                qualified: None,
                dispatch: None,
            },
        )
        .map_err(|error| error.to_string())?;
        Ok(RunnerContractRoute {
            entry_hash: entry_hash.to_owned(),
            code_hash: code_hash.to_owned(),
            upstream: RunnerActionUpstream::embedded(upstream),
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
