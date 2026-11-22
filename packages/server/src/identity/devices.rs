use super::{AuthContext, Device, Identities, Member, Role, User, hash, name, now};
use serde::{Deserialize, Serialize};
use std::io;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Kind {
    // In-process and loopback calls identify the local computer.
    Local,
    // The configured owner key must stay usable for recovery.
    Bootstrap,
    // Issued credentials, including migrated invites, can be signed out.
    #[serde(rename = "device")]
    Issued,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct DeviceRecord {
    #[serde(flatten)]
    public: Device,
    kind: Kind,
    pub(super) token_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_seen: Option<u64>,
    #[serde(skip)]
    live_last_seen: Option<u64>,
    #[serde(skip)]
    open_sockets: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked_at: Option<u64>,
    #[serde(skip)]
    pub(super) cancelled: CancellationToken,
}

impl DeviceRecord {
    fn new(public: Device, kind: Kind, token_hash: String) -> Self {
        Self {
            public,
            kind,
            token_hash,
            last_seen: None,
            live_last_seen: None,
            open_sockets: 0,
            revoked_at: None,
            cancelled: CancellationToken::new(),
        }
    }

    pub(super) fn local(token: &str) -> Self {
        Self::new(Device::local(), Kind::Local, hash(token))
    }

    pub(super) fn bootstrap(token: &str) -> Self {
        Self::new(
            Device {
                id: "device:owner".into(),
                name: "Owner key".into(),
            },
            Kind::Bootstrap,
            hash(token),
        )
    }

    pub(super) fn invite(member_id: &str, token_hash: String) -> Self {
        Self::new(
            Device {
                id: format!("device:{member_id}"),
                name: "Invite device".into(),
            },
            Kind::Issued,
            token_hash,
        )
    }

    pub(super) fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }

    pub(super) fn is_local(&self) -> bool {
        self.kind == Kind::Local
    }

    pub(super) fn caller(&self, user: &User) -> AuthContext {
        AuthContext {
            user: user.clone(),
            device: self.public.clone(),
        }
    }
}

#[derive(PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceEntry {
    #[serde(flatten)]
    device: Device,
    member: User,
    last_seen: Option<u64>,
    current: bool,
    online: bool,
}

pub(crate) enum DeviceSocket {
    Opened,
    Closed,
}

pub(crate) enum RevokeError {
    Unknown,
    Forbidden,
    Store(io::Error),
}

impl Member {
    pub(super) fn migrate_device(&mut self) {
        // Only the current server configuration can authorize the bootstrap key.
        if let Some(token_hash) = self.token_hash.take()
            && self.user.role != Role::Owner
        {
            self.devices
                .push(DeviceRecord::invite(&self.user.id, token_hash));
        }
    }

    pub(super) fn set_bootstrap_key(&mut self, token: &str) {
        if let Some(device) = self
            .devices
            .iter_mut()
            .find(|device| device.kind == Kind::Bootstrap)
        {
            device.token_hash = hash(token);
        } else {
            self.devices.push(DeviceRecord::bootstrap(token));
        }
    }
}

pub(super) fn generate_key() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    // Hex keeps all 256 bits and can be passed in an existing token field.
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl Identities {
    pub(crate) fn is_bootstrap(&self, caller: &AuthContext) -> bool {
        let members = self.members.lock().expect("members lock");
        active_device(&members, caller).is_some_and(|(_, device)| device.kind == Kind::Bootstrap)
    }

    /// Issue a device key after the core has resolved a successful sign-in to an active member.
    /// Return the secret once; only the digest goes into the member store.
    pub fn issue_device(
        &self,
        member_id: &str,
        device_name: &str,
    ) -> Result<(Device, String), String> {
        let device = Device {
            id: uuid::Uuid::new_v4().to_string(),
            name: name(device_name)?,
        };
        let key = generate_key()?;
        self.change(
            |error| error.to_string(),
            |members| {
                let member = members
                    .iter_mut()
                    .find(|member| member.user.id == member_id && member.revoked_at.is_none())
                    .ok_or("Unknown member")?;
                member
                    .devices
                    .push(DeviceRecord::new(device.clone(), Kind::Issued, hash(&key)));
                Ok(())
            },
        )?;
        Ok((device, key))
    }

    pub(crate) fn revoke_device(&self, caller: &AuthContext, id: &str) -> Result<(), RevokeError> {
        let cancelled = self.change(RevokeError::Store, |members| {
            let (actor, _) = active_device(members, caller).ok_or(RevokeError::Forbidden)?;
            let actor = actor.user.clone();
            let device = members
                .iter_mut()
                .filter(|member| member.revoked_at.is_none() && can_manage(&actor, member))
                .flat_map(|member| &mut member.devices)
                .find(|device| device.public.id == id && device.kind == Kind::Issued)
                .ok_or(RevokeError::Unknown)?;
            device.revoked_at.get_or_insert_with(now);
            Ok(device.cancelled.clone())
        })?;
        cancelled.cancel();
        Ok(())
    }

    pub(crate) fn device_updates(&self) -> tokio::sync::watch::Receiver<()> {
        self.device_changes.subscribe()
    }

    pub(crate) fn devices(&self, caller: &AuthContext) -> Option<Vec<DeviceEntry>> {
        let members = self.members.lock().expect("members lock");
        let (actor, _) = active_device(&members, caller)?;
        Some(
            members
                .iter()
                .filter(|member| member.revoked_at.is_none() && can_manage(&actor.user, member))
                .flat_map(|member| member.devices.iter().map(move |device| (member, device)))
                // The bootstrap key is a recovery credential, outside device sign-out.
                .filter(|(_, device)| device.kind == Kind::Issued && device.is_active())
                .map(|(member, device)| DeviceEntry {
                    current: device.public.id == caller.device.id,
                    device: device.public.clone(),
                    member: member.user.clone(),
                    last_seen: device.live_last_seen.max(device.last_seen),
                    online: device.open_sockets > 0,
                })
                .collect(),
        )
    }

    pub(crate) fn record_last_seen(&self, caller: &AuthContext, socket: DeviceSocket) {
        let mut members = self.members.lock().expect("members lock");
        let Some(device) = active_device_mut(&mut members, caller) else {
            return;
        };
        if device.kind != Kind::Issued {
            return;
        }
        match socket {
            DeviceSocket::Opened => device.open_sockets += 1,
            DeviceSocket::Closed => device.open_sockets -= 1,
        }
        device.live_last_seen = Some(now()).max(device.live_last_seen);
        self.device_changes.send_replace(());
    }

    pub(crate) fn flush_last_seen(&self) -> io::Result<()> {
        if self.path.is_none() {
            return Ok(());
        }
        // Serialize with durable identity edits, but release the members lock
        // before writing so authentication and socket updates never wait on this fsync.
        let _writer = self.writer.lock().expect("members writer lock");
        let mut snapshot = {
            let members = self.members.lock().expect("members lock");
            if !members
                .iter()
                .flat_map(|m| &m.devices)
                .any(|device| device.live_last_seen > device.last_seen)
            {
                return Ok(());
            }
            members.clone()
        };
        for device in snapshot.iter_mut().flat_map(|m| &mut m.devices) {
            device.last_seen = device.last_seen.max(device.live_last_seen);
        }
        self.save(&snapshot)?;

        // The writer lock keeps membership and device order unchanged during the
        // write. Copy back only the saved timestamps; sockets may have moved on.
        let mut members = self.members.lock().expect("members lock");
        for (device, saved) in members
            .iter_mut()
            .flat_map(|m| &mut m.devices)
            .zip(snapshot.iter().flat_map(|m| &m.devices))
        {
            device.last_seen = saved.last_seen;
        }
        Ok(())
    }
}

impl Member {
    pub(super) fn active_device_index(&self, caller: &AuthContext) -> Option<usize> {
        self.devices
            .iter()
            .position(|device| device.public.id == caller.device.id && device.is_active())
    }
}

fn active_device_indices(members: &[Member], caller: &AuthContext) -> Option<(usize, usize)> {
    let member = members
        .iter()
        .position(|member| member.revoked_at.is_none() && member.user.id == caller.user.id)?;
    let device = members[member].active_device_index(caller)?;
    Some((member, device))
}

fn active_device<'a>(
    members: &'a [Member],
    caller: &AuthContext,
) -> Option<(&'a Member, &'a DeviceRecord)> {
    let (member, device) = active_device_indices(members, caller)?;
    Some((&members[member], &members[member].devices[device]))
}

fn active_device_mut<'a>(
    members: &'a mut [Member],
    caller: &AuthContext,
) -> Option<&'a mut DeviceRecord> {
    let (member, device) = active_device_indices(members, caller)?;
    Some(&mut members[member].devices[device])
}

fn can_manage(actor: &User, target: &Member) -> bool {
    actor.id == target.user.id || matches!(actor.role, Role::Owner | Role::Admin)
}
