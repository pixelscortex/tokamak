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

    pub fn configure(&self, identities: Arc<Identities>, url: Option<String>) {
        let _ = self.identities.set(identities);
        let _ = self.url.set(url);
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
    ) -> Result<RunnerDispatch, MachineFailure> {
        let identities = self.identities.get().ok_or(MachineFailure::Forbidden)?;
        let user = note
            .auth
            .as_ref()
            .filter(|auth| auth.is_person())
            .map(|auth| auth.user.id.as_str());
        let plugin_owned = id.starts_with("machine:");
        let allowed = if plugin_owned {
            identities.plugin_owns_machine(plugin, id)
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
        let user = note
            .auth
            .as_ref()
            .filter(|auth| auth.is_person())
            .map(|auth| auth.user.id.clone());
        ops.register_async("machines.list", move |_| {
            let mut entries = machines
                .identities
                .get()
                .map_or_else(Vec::new, |identities| {
                    let mut entries = identities.plugin_machine_entries(Some(&plugin));
                    if let Some(user) = &user {
                        entries.extend(identities.personal_machines(user));
                    }
                    entries
                });
            let connections = machines.connections.lock().expect("machine registry");
            for entry in &mut entries {
                entry["online"] = json!(
                    entry["id"]
                        .as_str()
                        .and_then(|id| connections.get(id))
                        .is_some_and(|machine| !machine.revoked.is_cancelled())
                );
            }
            async move { Ok(Value::Array(entries)) }
        })
    }

    pub(super) fn register_management(
        self: &Arc<Self>,
        ops: &mut OpRegistry,
        plugin: String,
        plugin_name: String,
        note: CallNote,
    ) -> Result<(), engine::Error> {
        let url = self.url.get().cloned().flatten();
        ops.register_call("server.url", move |_| {
            let url = url.clone();
            async move { Ok(json!(url)) }
        })?;

        let machines = self.clone();
        let owner = plugin.clone();
        ops.register_call("machines.create", move |payload| {
            let (machines, owner, plugin_name) =
                (machines.clone(), owner.clone(), plugin_name.clone());
            async move {
                let label = payload["name"]
                    .as_str()
                    .ok_or("Missing machine name")?
                    .to_owned();
                Ok(tokio::task::spawn_blocking(move || {
                    let identities = machines
                        .identities
                        .get()
                        .ok_or("Machine storage unavailable")?;
                    identities.create_plugin_machine(&owner, &plugin_name, &label)
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

    async fn wait_online(&self, id: &str, plugin: &str, note: &CallNote, limit: Duration) -> Value {
        let Some(identities) = self.identities.get() else {
            return MachineFailure::Forbidden.value();
        };
        let mut changes = self.changed.subscribe();
        let mut credentials = identities.device_updates();
        let wait = async {
            loop {
                match self.named(id, plugin, note) {
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
