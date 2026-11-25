use super::{Identities, devices::generate_key, hash, name, now};
use crate::actions::MachineFailure;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io, io::Write, path::PathBuf, sync::Mutex};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

pub(super) const FILE_NAME: &str = "plugin-machines.json";
const MAX_ACTIVE_MACHINES_PER_PLUGIN: usize = 100;
const REMOVED_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Deserialize, Serialize)]
struct Record {
    id: String,
    name: String,
    plugin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    member: Option<String>,
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
        let mut entry = json!({
            "id": self.id,
            "name": self.name,
            "owner": {"kind":"plugin", "plugin":self.plugin},
            "online": self.sockets > 0,
            "lastSeen": self.last_seen.max(self.live_last_seen),
        });
        if let Some(member) = &self.member {
            entry["member"] = json!(member);
        }
        entry
    }
}

#[derive(Default)]
pub(super) struct Store {
    path: Option<PathBuf>,
    records: Mutex<Vec<Record>>,
    writer: Mutex<()>,
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
            writer: Mutex::new(()),
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
    fn edit<T>(&self, change: impl FnOnce(&mut Vec<Record>) -> Option<T>) -> io::Result<Option<T>> {
        let _writer = self.writer.lock().expect("plugin machines writer");
        let mut next = self.records.lock().expect("plugin machines").clone();
        let Some(result) = change(&mut next) else {
            return Ok(None);
        };
        let cutoff = now().saturating_sub(REMOVED_RETENTION_MS);
        next.retain(|record| record.removed_at.is_none_or(|removed| removed >= cutoff));
        self.save(&next)?;

        let mut records = self.records.lock().expect("plugin machines");
        // Socket updates can proceed during fsync; keep their newer live state.
        let current: std::collections::HashMap<_, _> = records
            .iter()
            .map(|record| (record.id.as_str(), record))
            .collect();
        for record in &mut next {
            if let Some(old) = current.get(record.id.as_str()) {
                record.live_last_seen = old.live_last_seen;
                record.sockets = old.sockets;
                if record.key_hash.is_none() && old.key_hash.is_some() {
                    old.revoked.cancel();
                }
            }
        }
        *records = next;
        Ok(Some(result))
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

    pub(crate) fn plugin_machine_allowed(
        &self,
        plugin: &str,
        id: &str,
        user: Option<&str>,
        server: bool,
    ) -> bool {
        self.plugin_machines
            .records
            .lock()
            .expect("plugin machines")
            .iter()
            .any(|record| {
                record.id == id
                    && record.plugin == plugin
                    && record.key_hash.is_some()
                    && match record.member.as_deref() {
                        Some(member) => Some(member) == user,
                        None => server,
                    }
            })
    }

    pub(crate) fn create_plugin_machine(
        &self,
        plugin: &str,
        label: &str,
        member: Option<String>,
    ) -> Result<Value, String> {
        if member
            .as_deref()
            .is_some_and(|id| self.active_member(id).is_none())
        {
            return Ok(MachineFailure::Forbidden.value());
        }
        let name = name(label)?;
        let key = generate_key()?;
        let id = format!("machine:{}", uuid::Uuid::new_v4());
        let created = self
            .plugin_machines
            .edit(|records| {
                if records
                    .iter()
                    .filter(|record| record.plugin == plugin && record.key_hash.is_some())
                    .count()
                    >= MAX_ACTIVE_MACHINES_PER_PLUGIN
                {
                    return None;
                }
                records.push(Record {
                    id: id.clone(),
                    name,
                    plugin: plugin.into(),
                    member,
                    created_at: now(),
                    removed_at: None,
                    key_hash: Some(hash(&key)),
                    last_seen: None,
                    live_last_seen: None,
                    revoked: CancellationToken::new(),
                    sockets: 0,
                });
                Some(())
            })
            .map_err(|error| error.to_string())?;
        if created.is_none() {
            return Ok(MachineFailure::Limit.value());
        }
        self.device_changes.send_replace(());
        Ok(json!({"id":id,"key":key}))
    }

    pub(crate) fn remove_plugin_machine(&self, plugin: &str, id: &str) -> Result<bool, String> {
        self.revoke_plugin_machines(|owner, machine| plugin == owner && id == machine)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn revoke_plugin_machines(
        &self,
        revoke: impl Fn(&str, &str) -> bool,
    ) -> io::Result<bool> {
        let removed = self
            .plugin_machines
            .edit(|records| {
                let mut changed = false;
                for record in records {
                    if record.key_hash.is_some() && revoke(&record.plugin, &record.id) {
                        record.key_hash = None;
                        record.removed_at = Some(now());
                        changed = true;
                    }
                }
                changed.then_some(())
            })?
            .is_some();
        if removed {
            self.device_changes.send_replace(());
        }
        Ok(removed)
    }

    pub(crate) fn plugin_machine_entries(
        &self,
        plugin: &str,
        user: Option<&str>,
        all: bool,
    ) -> Vec<Value> {
        self.plugin_machines
            .records
            .lock()
            .expect("plugin machines")
            .iter()
            .filter(|record| {
                record.key_hash.is_some()
                    && record.plugin == plugin
                    && (all || user.is_some_and(|user| record.member.as_deref() == Some(user)))
            })
            .map(Record::entry)
            .collect()
    }

    pub(crate) fn plugin_machine_snapshots(
        &self,
        name: impl Fn(&str) -> Option<String>,
    ) -> Vec<Value> {
        let records: Vec<_> = self
            .plugin_machines
            .records
            .lock()
            .expect("plugin machines")
            .iter()
            .filter(|record| record.key_hash.is_some())
            .map(Record::entry)
            .collect();
        records
            .into_iter()
            .filter_map(|mut entry| {
                let plugin = entry["owner"]["plugin"].as_str()?;
                entry["owner"]["name"] = json!(name(plugin)?);
                if let Some(id) = entry["member"].as_str() {
                    let display_name = self.member_name(id).unwrap_or_else(|| id.to_owned());
                    entry["member"] = json!({"id":id,"name":display_name});
                }
                Some(entry)
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
        self.plugin_machines.edit(|records| {
            let cutoff = now().saturating_sub(REMOVED_RETENTION_MS);
            let mut changed = false;
            for record in records {
                changed |= record.live_last_seen > record.last_seen
                    || record.removed_at.is_some_and(|removed| removed < cutoff);
                record.last_seen = record.last_seen.max(record.live_last_seen);
            }
            changed.then_some(())
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::DeviceSocket;

    #[test]
    fn active_machine_limit_is_per_plugin_and_expired_tombstones_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let identities =
            Identities::hosted(dir.path().join("members.json"), "owner-key", "Owner").unwrap();
        let mut first = None;
        for n in 0..MAX_ACTIVE_MACHINES_PER_PLUGIN {
            let result = identities
                .create_plugin_machine("sandbox", "Sandbox", None)
                .unwrap();
            assert!(result["key"].is_string());
            if n == 0 {
                first = result["id"].as_str().map(str::to_owned);
            }
        }
        assert_eq!(
            identities
                .create_plugin_machine("sandbox", "Overflow", None)
                .unwrap(),
            MachineFailure::Limit.value(),
        );
        assert!(
            identities
                .create_plugin_machine("other", "Other", None)
                .unwrap()["key"]
                .is_string()
        );

        let first = first.unwrap();
        assert!(identities.remove_plugin_machine("sandbox", &first).unwrap());
        let replacement = identities
            .create_plugin_machine("sandbox", "Replacement", None)
            .unwrap();
        assert_ne!(replacement["id"], first);
        for record in identities
            .plugin_machines
            .records
            .lock()
            .unwrap()
            .iter_mut()
        {
            if record.id == first {
                record.removed_at = Some(0);
            }
        }
        identities.flush_plugin_machine_presence().unwrap();
        let stored = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(!stored.contains(&first));
    }

    #[test]
    fn plugin_machine_credentials_and_presence_survive_restart_until_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("members.json");
        let open = || Identities::hosted(path.clone(), "owner-key", "Owner").unwrap();
        let identities = open();
        let result = identities
            .create_plugin_machine("sandbox", "Test machine", None)
            .unwrap();
        let id = result["id"].as_str().unwrap();
        let key = result["key"].as_str().unwrap();
        identities.plugin_machine_seen(id, DeviceSocket::MachineOpened);
        identities.flush_plugin_machine_presence().unwrap();
        drop(identities);

        let identities = open();
        let (_, _, revoked) = identities.authenticate_plugin_machine(key).unwrap();
        assert!(identities.authenticate(key).is_none());
        let entries = identities.plugin_machine_entries("sandbox", None, true);
        assert_eq!(entries[0]["online"], false);
        assert!(entries[0]["lastSeen"].is_u64());

        assert!(identities.plugin_machine_allowed("sandbox", id, None, true));
        assert!(!identities.plugin_machine_allowed("sandbox", id, None, false));
        assert!(!identities.plugin_machine_allowed("outsider", id, None, true));
        assert!(identities.remove_plugin_machine("sandbox", id).unwrap());
        assert!(revoked.is_cancelled());
        assert!(open().authenticate_plugin_machine(key).is_none());
    }
}
