use super::RunnerDispatch;
use crate::identity::{AuthContext, LOCAL_DEVICE_ID};
use std::{
    collections::{HashMap, hash_map::Entry},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct Machines(Mutex<HashMap<String, Machine>>);

struct Machine {
    owner: Owner,
    dispatch: RunnerDispatch,
}

enum Owner {
    Embedded,
    Person { id: String, stop: CancellationToken },
}

pub(crate) enum Selection {
    Attached(RunnerDispatch),
    Connected(RunnerDispatch),
    Absent,
}

impl Machines {
    pub fn attach(&self, dispatch: RunnerDispatch) -> bool {
        let mut machines = self.0.lock().expect("machine registry");
        let Entry::Vacant(slot) = machines.entry(LOCAL_DEVICE_ID.to_owned()) else {
            return false;
        };
        slot.insert(Machine {
            owner: Owner::Embedded,
            dispatch,
        });
        true
    }

    pub fn connect(
        &self,
        auth: &AuthContext,
        dispatch: RunnerDispatch,
        stop: CancellationToken,
    ) -> Connection<'_> {
        let mut machines = self.0.lock().expect("machine registry");
        if let Some(old) = machines.insert(
            auth.device.id.clone(),
            Machine {
                owner: Owner::Person {
                    id: auth.user.id.clone(),
                    stop: stop.clone(),
                },
                dispatch,
            },
        ) && let Owner::Person { stop, .. } = old.owner
        {
            stop.cancel();
        }

        Connection {
            machines: self,
            device: auth.device.id.clone(),
            stop,
        }
    }

    pub fn select(&self, auth: &AuthContext, continuation: bool) -> Selection {
        let machines = self.0.lock().expect("machine registry");
        let Some(machine) = machines.get(&auth.device.id) else {
            return Selection::Absent;
        };
        match &machine.owner {
            Owner::Embedded if auth.is_on_this_machine() && !continuation => {
                Selection::Attached(machine.dispatch.clone())
            }
            Owner::Person { id, .. } if id == &auth.user.id => {
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
        let mut machines = self.machines.0.lock().expect("machine registry");
        // Replacement cancels this token while holding the same lock.
        if let Entry::Occupied(slot) = machines.entry(self.device.clone())
            && !self.stop.is_cancelled()
        {
            slot.remove();
        }
    }
}
