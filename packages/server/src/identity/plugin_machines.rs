use super::{Identities, devices::generate_key, hash, name, now};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io, io::Write, path::PathBuf, sync::Mutex};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize, Serialize)]
struct Record {
    id: String,
    name: String,
    plugin: String,
    plugin_name: String,
    created_at: u64,
    removed_at: Option<u64>,
    key_hash: Option<String>,
    last_seen: Option<u64>,
    #[serde(skip)]
    revoked: CancellationToken,
    #[serde(skip)]
    live_last_seen: Option<u64>,
    #[serde(skip)]
    sockets: usize,
}

impl Record {
    fn entry(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "owner": {"kind":"plugin", "plugin":self.plugin},
            "online": self.sockets > 0,
            "lastSeen": self.last_seen.max(self.live_last_seen),
        })
    }
}

#[derive(Default)]
pub(super) struct Store {
    path: Option<PathBuf>,
    records: Mutex<Vec<Record>>,
}

impl Store {
    pub(super) fn open(path: PathBuf) -> io::Result<Self> {
        let records = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            path: Some(path),
            records: Mutex::new(records),
        })
    }

    fn save(&self, records: &[Record]) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let directory = path
            .parent()
            .ok_or_else(|| io::Error::other("Missing machines directory"))?;
        std::fs::create_dir_all(directory)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(&serde_json::to_vec_pretty(records)?)?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|error| error.error)?;
        Ok(())
    }
}

impl Identities {
    pub(crate) fn authenticate_plugin_machine(
        &self,
        key: &str,
    ) -> Option<(String, String, CancellationToken)> {
        let actual = hash(key);
        let records = self
            .plugin_machines
            .records
            .lock()
            .expect("plugin machines");
        let mut found = None;
        for record in records.iter() {
            if let Some(digest) = &record.key_hash
                && bool::from(actual.as_bytes().ct_eq(digest.as_bytes()))
            {
                found = Some((
                    record.id.clone(),
                    record.plugin.clone(),
                    record.revoked.clone(),
                ));
            }
        }
        found
    }

    pub(crate) fn plugin_owns_machine(&self, plugin: &str, id: &str) -> bool {
        self.plugin_machines
            .records
            .lock()
            .expect("plugin machines")
            .iter()
            .any(|record| record.id == id && record.plugin == plugin && record.key_hash.is_some())
    }

    pub(crate) fn create_plugin_machine(
        &self,
        plugin: &str,
        plugin_name: &str,
        label: &str,
    ) -> Result<Value, String> {
        let name = name(label)?;
        let key = generate_key()?;
        let mut records = self
            .plugin_machines
            .records
            .lock()
            .expect("plugin machines");
        let id = loop {
            let id = format!("machine:{}", uuid::Uuid::new_v4());
            if records.iter().all(|record| record.id != id) {
                break id;
            }
        };
        records.push(Record {
            id: id.clone(),
            name,
            plugin: plugin.into(),
            plugin_name: plugin_name.into(),
            created_at: now(),
            removed_at: None,
            key_hash: Some(hash(&key)),
            last_seen: None,
            live_last_seen: None,
            revoked: CancellationToken::new(),
            sockets: 0,
        });
        if let Err(error) = self.plugin_machines.save(&records) {
            records.pop();
            return Err(error.to_string());
        }
        self.device_changes.send_replace(());
        Ok(json!({"id":id,"key":key}))
    }

    pub(crate) fn remove_plugin_machine(&self, plugin: &str, id: &str) -> Result<bool, String> {
        let mut records = self
            .plugin_machines
            .records
            .lock()
            .expect("plugin machines");
        let Some(index) = records.iter().position(|record| {
            record.id == id && record.plugin == plugin && record.key_hash.is_some()
        }) else {
            return Ok(false);
        };
        let digest = records[index].key_hash.take();
        records[index].removed_at = Some(now());
        if let Err(error) = self.plugin_machines.save(&records) {
            records[index].key_hash = digest;
            records[index].removed_at = None;
            return Err(error.to_string());
        }
        records[index].revoked.cancel();
        self.device_changes.send_replace(());
        Ok(true)
    }

    pub(crate) fn plugin_machine_entries(&self, plugin: Option<&str>) -> Vec<Value> {
        self.plugin_machines
            .records
            .lock()
            .expect("plugin machines")
            .iter()
            .filter(|record| {
                record.key_hash.is_some() && plugin.is_none_or(|id| record.plugin == id)
            })
            .map(|record| {
                let mut entry = record.entry();
                if plugin.is_none() {
                    entry["owner"]["name"] = json!(record.plugin_name);
                }
                entry
            })
            .collect()
    }

    pub(crate) fn plugin_machine_seen(&self, id: &str, socket: super::DeviceSocket) {
        use super::DeviceSocket::*;
        let mut records = self
            .plugin_machines
            .records
            .lock()
            .expect("plugin machines");
        let Some(record) = records
            .iter_mut()
            .find(|record| record.id == id && record.key_hash.is_some())
        else {
            return;
        };
        let seen = now();
        match socket {
            MachineOpened => record.sockets += 1,
            MachineClosed => record.sockets = record.sockets.saturating_sub(1),
            MachineHeartbeat
                if record
                    .live_last_seen
                    .is_some_and(|last| seen.saturating_sub(last) < 60_000) =>
            {
                return;
            }
            MachineHeartbeat => {}
            _ => return,
        }
        record.live_last_seen = record.live_last_seen.max(Some(seen));
        self.device_changes.send_replace(());
    }

    pub(crate) fn flush_plugin_machine_presence(&self) -> io::Result<()> {
        let mut records = self
            .plugin_machines
            .records
            .lock()
            .expect("plugin machines");
        if records
            .iter()
            .any(|record| record.live_last_seen > record.last_seen)
        {
            let mut snapshot = records.clone();
            for record in &mut snapshot {
                record.last_seen = record.last_seen.max(record.live_last_seen);
            }
            self.plugin_machines.save(&snapshot)?;
            *records = snapshot;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::Machines;
    use crate::identity::{CallNote, DeviceSocket};
    use std::sync::Arc;

    #[test]
    fn plugin_machine_credentials_and_presence_survive_restart_until_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("members.json");
        let open = || Identities::hosted(path.clone(), "owner-key", "Owner").unwrap();
        let identities = open();
        let result = identities
            .create_plugin_machine("sandbox", "Sandbox", "Test machine")
            .unwrap();
        let id = result["id"].as_str().unwrap();
        let key = result["key"].as_str().unwrap();
        identities.plugin_machine_seen(id, DeviceSocket::MachineOpened);
        identities.flush_plugin_machine_presence().unwrap();
        drop(identities);

        let identities = Arc::new(open());
        let (_, _, revoked) = identities.authenticate_plugin_machine(key).unwrap();
        assert!(identities.authenticate(key).is_none());
        let entries = identities.plugin_machine_entries(Some("sandbox"));
        assert_eq!(entries[0]["online"], false);
        assert!(entries[0]["lastSeen"].is_u64());

        let machines = Machines::default();
        machines.configure(identities.clone(), None);
        let note = CallNote::from(None);
        assert!(matches!(
            machines.named(id, "sandbox", &note),
            Err(crate::actions::MachineFailure::Offline)
        ));
        assert!(matches!(
            machines.named(id, "outsider", &note),
            Err(crate::actions::MachineFailure::Forbidden)
        ));
        assert!(identities.remove_plugin_machine("sandbox", id).unwrap());
        assert!(revoked.is_cancelled());
        assert!(open().authenticate_plugin_machine(key).is_none());
    }
}
