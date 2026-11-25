use super::RunnerDispatch;
use crate::identity::{AuthContext, LOCAL_DEVICE_ID};
use std::{
    collections::{HashMap, hash_map::Entry},
    sync::Mutex,
};

#[derive(Default)]
pub(crate) struct Machines(Mutex<HashMap<String, Machine>>);

struct Machine {
    owner: Option<String>,
    dispatch: RunnerDispatch,
}

pub(crate) enum Selection {
    Attached(RunnerDispatch),
    Connected(RunnerDispatch),
    Ambiguous,
    Absent,
}

impl Machines {
    pub fn attach(&self, dispatch: RunnerDispatch) -> bool {
        self.register(
            LOCAL_DEVICE_ID,
            Machine {
                owner: None,
                dispatch,
            },
        )
    }

    pub fn connect(&self, auth: &AuthContext, dispatch: RunnerDispatch) -> Option<Connection<'_>> {
        self.register(
            &auth.device.id,
            Machine {
                owner: Some(auth.user.id.clone()),
                dispatch,
            },
        )
        .then(|| Connection {
            machines: self,
            device: auth.device.id.clone(),
        })
    }

    fn register(&self, device: &str, machine: Machine) -> bool {
        let mut machines = self.0.lock().expect("machine registry");
        let Entry::Vacant(slot) = machines.entry(device.to_owned()) else {
            return false;
        };
        slot.insert(machine);
        true
    }

    pub fn select(&self, auth: &AuthContext, continuation: bool, window: bool) -> Selection {
        let machines = self.0.lock().expect("machine registry");
        if let Some(machine) = machines.get(&auth.device.id)
            && machine.owner.as_ref().map_or_else(
                || auth.is_on_this_machine() && !continuation,
                |owner| owner == &auth.user.id,
            )
        {
            return if machine.owner.is_some() {
                Selection::Connected(machine.dispatch.clone())
            } else {
                Selection::Attached(machine.dispatch.clone())
            };
        }

        if window {
            return Selection::Absent;
        }

        let mut owned = machines
            .values()
            .filter(|machine| machine.owner.as_ref() == Some(&auth.user.id));
        match (owned.next(), owned.next()) {
            (Some(machine), None) => Selection::Connected(machine.dispatch.clone()),
            (Some(_), Some(_)) => Selection::Ambiguous,
            _ => Selection::Absent,
        }
    }
}

pub(crate) struct Connection<'a> {
    machines: &'a Machines,
    device: String,
}

impl Drop for Connection<'_> {
    fn drop(&mut self) {
        self.machines
            .0
            .lock()
            .expect("machine registry")
            .remove(&self.device);
    }
}
