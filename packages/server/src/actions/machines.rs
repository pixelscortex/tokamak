use super::{MachineFailure, RunnerDispatch};
use crate::identity::{AuthContext, LOCAL_DEVICE_ID};
use crate::identity::{CallNote, Identities};
use engine::OpRegistry;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, hash_map::Entry},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct Machines {
    connections: Mutex<HashMap<String, Machine>>,
    identities: OnceLock<Arc<Identities>>,
    plugins: Mutex<Option<Arc<super::Loaded>>>,
    url: OnceLock<Option<String>>,
    changed: tokio::sync::watch::Sender<()>,
}

struct Machine {
    owner: Owner,
    dispatch: RunnerDispatch,
    stop: CancellationToken,
    revoked: CancellationToken,
}

pub(crate) enum Owner {
    Embedded,
    Person(String),
    Plugin(String),
}

pub(crate) enum Selection {
    Attached(RunnerDispatch),
    Connected(RunnerDispatch),
    Absent,
}

impl Machines {
    pub fn attach(&self, dispatch: RunnerDispatch) -> bool {
        let mut machines = self.connections.lock().expect("machine registry");
        let Entry::Vacant(slot) = machines.entry(LOCAL_DEVICE_ID.to_owned()) else {
            return false;
        };
        slot.insert(Machine {
            owner: Owner::Embedded,
            dispatch,
            stop: CancellationToken::new(),
            revoked: CancellationToken::new(),
        });
        true
    }

    pub fn configure(
        &self,
        identities: Arc<Identities>,
        url: Option<String>,
    ) -> std::io::Result<()> {
        let plugins = self.plugins.lock().expect("machine plugins");
        identities.revoke_plugin_machines(|id, _| {
            plugins
                .as_ref()
                .is_none_or(|loaded| !loaded.catalog.plugins.contains_key(id))
        })?;
        let _ = self.identities.set(identities);
        let _ = self.url.set(url);
        Ok(())
    }

    pub fn update_plugins(&self, next: Option<Arc<super::Loaded>>) -> std::io::Result<()> {
        let mut plugins = self.plugins.lock().expect("machine plugins");
        if let Some(identities) = self.identities.get() {
            identities.revoke_plugin_machines(|id, _| {
                next.as_ref()
                    .is_none_or(|loaded| !loaded.catalog.plugins.contains_key(id))
            })?;
        }
        *plugins = next;
        if let Some(identities) = self.identities.get() {
            identities.device_changes.send_replace(());
        }
        Ok(())
    }

    pub fn snapshots(&self, identities: &Identities) -> Vec<Value> {
        let plugins = self.plugins.lock().expect("machine plugins");
        identities.plugin_machine_snapshots(|id| {
            let plugin = &plugins.as_ref()?.catalog.plugins.get(id)?.manifest.plugin;
            Some(plugin.name.clone().unwrap_or_else(|| id.to_owned()))
        })
    }

    pub fn connect(
        &self,
        id: &str,
        owner: Owner,
        dispatch: RunnerDispatch,
        stop: CancellationToken,
        revoked: CancellationToken,
    ) -> Option<Connection<'_>> {
        let mut machines = self.connections.lock().expect("machine registry");
        if revoked.is_cancelled() {
            return None;
        }
        if let Some(old) = machines.insert(
            id.to_owned(),
            Machine {
                owner,
                dispatch,
                stop: stop.clone(),
                revoked,
            },
        ) {
            old.stop.cancel();
        }
        self.changed.send_replace(());

        Some(Connection {
            machines: self,
            device: id.to_owned(),
            stop,
        })
    }

    pub fn named(
        &self,
        id: &str,
        plugin: &str,
        note: &CallNote,
        server: bool,
    ) -> Result<RunnerDispatch, MachineFailure> {
        let identities = self.identities.get().ok_or(MachineFailure::Forbidden)?;
        let user = member(note);
        let plugin_owned = id.starts_with("machine:");
        let allowed = if plugin_owned {
            identities.plugin_machine_allowed(plugin, id, user, server)
        } else {
            user.is_some_and(|user| identities.owns_machine(user, id))
        };
        if !allowed {
            return Err(MachineFailure::Forbidden);
        }

        let machines = self.connections.lock().expect("machine registry");
        let machine = machines
            .get(id)
            .filter(|machine| !machine.revoked.is_cancelled());
        match machine {
            Some(Machine {
                owner: Owner::Plugin(owner),
                dispatch,
                ..
            }) if owner == plugin => Ok(dispatch.clone()),
            Some(Machine {
                owner: Owner::Person(owner),
                dispatch,
                ..
            }) if Some(owner.as_str()) == user => Ok(dispatch.clone()),
            _ => Err(MachineFailure::Offline),
        }
    }

    pub(crate) fn register_list(
        self: &Arc<Self>,
        ops: &mut OpRegistry,
        plugin: String,
        note: &CallNote,
    ) -> Result<(), engine::Error> {
        let machines = self.clone();
        let user = member(note).map(str::to_owned);
        ops.register_async("machines.list", move |_| {
            let entries = machines.list(&plugin, user.as_deref(), false);
            async move { Ok(entries) }
        })
    }

    pub(crate) fn list(&self, plugin: &str, user: Option<&str>, all: bool) -> Value {
        let Some(identities) = self.identities.get() else {
            return json!([]);
        };
        let mut entries = identities.plugin_machine_entries(plugin, user, all);
        if let Some(user) = user {
            entries.extend(identities.personal_machines(user));
        }
        let connections = self.connections.lock().expect("machine registry");
        for entry in &mut entries {
            entry["online"] = json!(
                entry["id"]
                    .as_str()
                    .and_then(|id| connections.get(id))
                    .is_some_and(|machine| !machine.revoked.is_cancelled())
            );
        }
        Value::Array(entries)
    }

    pub(super) fn register_management(
        self: &Arc<Self>,
        ops: &mut OpRegistry,
        plugin: String,
        generation: Arc<super::Loaded>,
        internal: bool,
        note: CallNote,
    ) -> Result<(), engine::Error> {
        let url = self.url.get().cloned().flatten();
        ops.register_call("server.url", move |_| {
            let url = url.clone();
            async move { Ok(json!(url)) }
        })?;

        if internal {
            let machines = self.clone();
            let owner = plugin.clone();
            ops.register_call("machines.listAll", move |_| {
                let entries = machines.list(&owner, None, true);
                async move { Ok(entries) }
            })?;
        }

        let machines = self.clone();
        let owner = plugin.clone();
        ops.register_call("machines.create", move |payload| {
            let (machines, owner, generation) =
                (machines.clone(), owner.clone(), generation.clone());
            async move {
                let (label, member) = creation_args(&payload)?;
                Ok(tokio::task::spawn_blocking(move || {
                    machines.create(&generation, &owner, &label, member)
                })
                .await
                .map_err(|error| error.to_string())??)
            }
        })?;

        let machines = self.clone();
        let owner = plugin.clone();
        ops.register_call("machines.remove", move |payload| {
            let (machines, owner) = (machines.clone(), owner.clone());
            async move {
                let id = machine_id(&payload)?.to_owned();
                let removed = tokio::task::spawn_blocking(move || -> Result<bool, String> {
                    let identities = machines
                        .identities
                        .get()
                        .ok_or("Machine storage unavailable")?;
                    let removed = identities.remove_plugin_machine(&owner, &id)?;
                    Ok(removed)
                })
                .await
                .map_err(|error| error.to_string())??;
                Ok(if removed {
                    Value::Null
                } else {
                    MachineFailure::Forbidden.value()
                })
            }
        })?;

        let machines = self.clone();
        ops.register_call("machines.waitOnline", move |payload| {
            let (machines, plugin, note) = (machines.clone(), plugin.clone(), note.clone());
            async move {
                let id = machine_id(&payload)?;
                let ms = payload
                    .get("timeoutMs")
                    .map(|value| value.as_u64().ok_or("Invalid machine timeout"))
                    .transpose()?;
                Ok(machines
                    .wait_online(
                        id,
                        &plugin,
                        &note,
                        Duration::from_millis(ms.unwrap_or(30_000).min(120_000)),
                    )
                    .await)
            }
        })
    }

    fn create(
        &self,
        generation: &Arc<super::Loaded>,
        owner: &str,
        label: &str,
        member: Option<String>,
    ) -> Result<Value, String> {
        let plugins = self.plugins.lock().expect("machine plugins");
        if !plugins
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, generation))
        {
            return Ok(MachineFailure::Forbidden.value());
        }
        self.identities
            .get()
            .ok_or("Machine storage unavailable")?
            .create_plugin_machine(owner, label, member)
    }

    async fn wait_online(&self, id: &str, plugin: &str, note: &CallNote, limit: Duration) -> Value {
        let Some(identities) = self.identities.get() else {
            return MachineFailure::Forbidden.value();
        };
        let mut changes = self.changed.subscribe();
        let mut credentials = identities.device_updates();
        let wait = async {
            loop {
                match self.named(id, plugin, note, true) {
                    Ok(_) => return Value::Null,
                    Err(MachineFailure::Offline) => {}
                    Err(error) => return error.value(),
                }
                tokio::select! {
                    _ = changes.changed() => {}
                    _ = credentials.changed() => {}
                }
            }
        };
        tokio::time::timeout(limit, wait)
            .await
            .unwrap_or_else(|_| MachineFailure::Offline.value())
    }

    pub fn select(&self, auth: &AuthContext, continuation: bool) -> Selection {
        let machines = self.connections.lock().expect("machine registry");
        let Some(machine) = machines.get(&auth.device.id) else {
            return Selection::Absent;
        };
        match &machine.owner {
            Owner::Embedded if auth.is_on_this_machine() && !continuation => {
                Selection::Attached(machine.dispatch.clone())
            }
            Owner::Person(id) if id == &auth.user.id && !machine.revoked.is_cancelled() => {
                Selection::Connected(machine.dispatch.clone())
            }
            _ => Selection::Absent,
        }
    }
}

pub(crate) struct Connection<'a> {
    machines: &'a Machines,
    device: String,
    stop: CancellationToken,
}

impl Drop for Connection<'_> {
    fn drop(&mut self) {
        let mut machines = self.machines.connections.lock().expect("machine registry");
        // Replacement cancels this token while holding the same lock.
        if let Entry::Occupied(slot) = machines.entry(self.device.clone())
            && !self.stop.is_cancelled()
        {
            slot.remove();
            self.machines.changed.send_replace(());
        }
    }
}

fn machine_id(payload: &Value) -> Result<&str, &'static str> {
    payload["id"].as_str().ok_or("Missing machine id")
}

fn member(note: &CallNote) -> Option<&str> {
    note.auth
        .as_ref()
        .filter(|auth| auth.is_person())
        .map(|auth| auth.user.id.as_str())
}

fn creation_args(payload: &Value) -> Result<(String, Option<String>), String> {
    let name = payload["name"].as_str().ok_or("Missing machine name")?;
    let member = payload
        .get("member")
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or("Invalid machine member")
        })
        .transpose()?;
    Ok((name.to_owned(), member))
}
