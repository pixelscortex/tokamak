//! Core caller identities. Existing invite tokens remain valid credentials.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::SystemTime,
};
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

mod accounts;
mod cli;
mod devices;
pub(crate) use accounts::AccountBinding;
pub use cli::command;
pub(crate) use devices::{DeviceSocket, RevokeError};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub name: String,
    pub role: Role,
}

impl User {
    pub fn local() -> Self {
        Self {
            id: "local".into(),
            name: std::env::var("TOKAMAK_OWNER_NAME").unwrap_or_else(|_| "You".into()),
            role: Role::Owner,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub name: String,
}

/// The public identity for one invocation. This carries no credentials.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthContext {
    pub user: User,
    pub device: Device,
}

impl AuthContext {
    pub fn local() -> Self {
        Self::in_process(User::local())
    }

    /// The server's own calls (plugin maintenance): not a person, not one of their devices.
    /// Plugins recognise it by the device id (`isServerCall` in the SDK).
    pub fn server() -> Self {
        Self {
            user: User {
                id: "server".into(),
                name: "Tokamak".into(),
                role: Role::Owner,
            },
            device: Device {
                id: "device:server".into(),
                name: "Server".into(),
            },
        }
    }

    pub(crate) fn in_process(user: User) -> Self {
        // In-process calls originate on this computer, regardless of whose profile they use.
        Self {
            user,
            device: Device::local(),
        }
    }
}

pub(crate) fn register_caller(
    caller: Option<&AuthContext>,
    ops: &mut engine::OpRegistry,
) -> Result<(), engine::Error> {
    // Old bundles still ask for the user alone.
    let user = serde_json::json!(caller.map(|auth| &auth.user));
    ops.register_sync("user.current", move |_| Ok(user.clone()))?;
    let auth = serde_json::json!(caller);
    ops.register_sync("auth.current", move |_| Ok(auth.clone()))
}

impl Device {
    fn local() -> Self {
        Self {
            id: "device:local".into(),
            name: local_device_name().to_owned(),
        }
    }
}

fn local_device_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        fn output(name: &str, args: &[&str]) -> Option<String> {
            let mut command = std::process::Command::new(name);
            command.args(args);
            #[cfg(all(target_os = "macos", feature = "local-runtime"))]
            let output = {
                command
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());
                tokamak_worker::with_spawn_lock(|| command.spawn())
                    .ok()?
                    .wait_with_output()
            };
            #[cfg(not(all(target_os = "macos", feature = "local-runtime")))]
            let output = command.output();
            let output = output.ok()?;
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                .filter(|name| !name.is_empty())
        }
        // macOS ComputerName is the name shown to the person in System Settings.
        let name = if cfg!(target_os = "macos") {
            output("/usr/sbin/scutil", &["--get", "ComputerName"])
        } else if cfg!(windows) {
            std::env::var("COMPUTERNAME").ok().filter(|n| !n.is_empty())
        } else {
            None
        };
        #[cfg(unix)]
        let hostname = system_hostname;
        #[cfg(not(unix))]
        let hostname = || output("hostname", &[]);
        name.or_else(hostname)
            .unwrap_or_else(|| "This computer".into())
    })
}

#[cfg(unix)]
fn system_hostname() -> Option<String> {
    // Minimal Unix installs may have no hostname executable.
    let mut buffer = [0u8; 256];
    // The buffer is writable for its full length. Some implementations omit
    // the terminator on truncation, so accept only a terminated result.
    if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
        return None;
    }
    let end = buffer.iter().position(|&byte| byte == 0)?;
    let hostname = String::from_utf8_lossy(&buffer[..end]);
    (!hostname.is_empty()).then(|| hostname.into_owned())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Member {
    #[serde(flatten)]
    pub user: User,
    // Read legacy member hashes for migration only; new saves keep hashes on devices.
    #[serde(default, skip_serializing)]
    token_hash: Option<String>,
    #[serde(default)]
    devices: Vec<devices::DeviceRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    accounts: Vec<AccountBinding>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<u64>,
}

pub struct Identities {
    path: Option<PathBuf>,
    members: Mutex<Vec<Member>>,
    writer: Mutex<()>,
    anonymous: bool,
    device_changes: watch::Sender<()>,
}

fn hash(token: &str) -> String {
    // SHA-256 is sufficient for uniformly random 256-bit invite tokens.
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock")
        .as_millis() as u64
}

pub fn name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100 || value.chars().any(char::is_control) {
        return Err("Name must contain 1–100 characters without control characters".into());
    }
    Ok(value.to_owned())
}

impl Identities {
    pub fn configure(
        data: &std::path::Path,
        token: Option<&str>,
        hosted: bool,
    ) -> io::Result<Self> {
        if hosted {
            Self::hosted(
                data.parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("members.json"),
                token.ok_or_else(|| io::Error::other("Hosted mode requires an owner token"))?,
                &std::env::var("TOKAMAK_OWNER_NAME").unwrap_or_else(|_| "Owner".into()),
            )
        } else {
            Ok(Self::local(token))
        }
    }
    pub fn bootstrap(token: &str) -> Self {
        Self {
            path: None,
            members: Mutex::new(vec![Self::owner(
                token,
                std::env::var("TOKAMAK_OWNER_NAME").unwrap_or_else(|_| "Owner".into()),
            )]),
            anonymous: false,
            writer: Mutex::new(()),
            device_changes: watch::Sender::new(()),
        }
    }
    pub fn local(token: Option<&str>) -> Self {
        Self {
            path: None,
            members: Mutex::new(vec![Member {
                user: User::local(),
                token_hash: None,
                devices: vec![devices::DeviceRecord::local(token.unwrap_or_default())],
                accounts: Vec::new(),
                created_at: now(),
                revoked_at: None,
            }]),
            anonymous: token.is_none(),
            writer: Mutex::new(()),
            device_changes: watch::Sender::new(()),
        }
    }

    pub fn hosted(path: PathBuf, token: &str, owner_name: &str) -> io::Result<Self> {
        let mut members: Vec<Member> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        for member in &mut members {
            member.migrate_device();
        }
        if let Some(owner) = members.iter_mut().find(|m| m.user.id == "owner") {
            if owner.user.role != Role::Owner {
                return Err(io::Error::other("The bootstrap account must be the owner"));
            }
            owner.set_bootstrap_key(token);
            owner.revoked_at = None;
        } else {
            members.push(Self::owner(
                token,
                name(owner_name).map_err(io::Error::other)?,
            ));
        }
        let identities = Self {
            path: Some(path),
            members: Mutex::new(members),
            anonymous: false,
            writer: Mutex::new(()),
            device_changes: watch::Sender::new(()),
        };
        identities.save(&identities.members.lock().expect("members lock"))?;
        Ok(identities)
    }

    fn owner(token: &str, name: String) -> Member {
        Member {
            user: User {
                id: "owner".into(),
                name,
                role: Role::Owner,
            },
            token_hash: None,
            devices: vec![devices::DeviceRecord::bootstrap(token)],
            accounts: Vec::new(),
            created_at: now(),
            revoked_at: None,
        }
    }

    pub fn identify(&self, token: &str) -> Option<User> {
        self.authenticate(token).map(|auth| auth.user)
    }

    /// Resolve a credential to the member and the particular device it belongs to.
    pub(crate) fn authenticate(&self, token: &str) -> Option<AuthContext> {
        let actual = hash(token);
        let members = self.members.lock().expect("members lock");
        let mut found = None;
        for member in members.iter() {
            for device in &member.devices {
                let matches = bool::from(actual.as_bytes().ct_eq(device.token_hash.as_bytes()));
                if (matches || (self.anonymous && device.is_local()))
                    && member.revoked_at.is_none()
                    && device.is_active()
                {
                    found = Some(device.caller(&member.user));
                }
            }
        }
        found
    }

    /// Re-read the profile when the authenticated connection is admitted.
    pub(crate) fn active_caller(
        &self,
        auth: &AuthContext,
    ) -> Option<(AuthContext, CancellationToken)> {
        self.with_active(&auth.user.id, |member| {
            let device = &member.devices[member.active_device_index(auth)?];
            Some((device.caller(&member.user), device.cancelled.clone()))
        })
    }

    pub fn list(&self) -> serde_json::Value {
        serde_json::Value::Array(self.members.lock().expect("members lock").iter().map(|m| {
            serde_json::json!({"id":m.user.id,"name":m.user.name,"role":m.user.role,"created_at":m.created_at,"revoked_at":m.revoked_at})
        }).collect())
    }

    pub fn revoke(&self, id: &str) -> Result<(), String> {
        self.remove_member(id).map(|_| ())
    }

    pub(crate) fn remove_member(&self, id: &str) -> Result<Option<User>, String> {
        let (user, cancelled) = self.change(
            |error| error.to_string(),
            |members| {
                let member = members
                    .iter_mut()
                    .find(|m| m.user.id == id)
                    .ok_or("Unknown member")?;
                if member.user.role == Role::Owner {
                    return Err("The bootstrap owner cannot be revoked".into());
                }
                if member.revoked_at.is_some() {
                    return Ok((None, Vec::new()));
                }
                member.revoked_at = Some(now());
                let cancelled: Vec<_> = member
                    .devices
                    .iter()
                    .map(|device| device.cancelled.clone())
                    .collect();
                Ok((Some(member.user.clone()), cancelled))
            },
        )?;
        for token in cancelled {
            token.cancel();
        }
        Ok(user)
    }

    pub(crate) fn active_member(&self, id: &str) -> Option<User> {
        self.with_active(id, |member| Some(member.user.clone()))
    }

    fn with_active<T>(&self, id: &str, read: impl FnOnce(&Member) -> Option<T>) -> Option<T> {
        self.members
            .lock()
            .expect("members lock")
            .iter()
            .find(|member| member.user.id == id && member.revoked_at.is_none())
            .and_then(read)
    }

    pub(crate) fn active_members(&self) -> Vec<(User, bool)> {
        self.members
            .lock()
            .expect("members lock")
            .iter()
            .filter(|member| member.revoked_at.is_none())
            .map(|member| (member.user.clone(), !member.accounts.is_empty()))
            .collect()
    }

    pub(crate) fn revoked_member_ids(&self) -> Vec<String> {
        self.members
            .lock()
            .expect("members lock")
            .iter()
            .filter(|member| member.revoked_at.is_some())
            .map(|member| member.user.id.clone())
            .collect()
    }

    pub fn rename(&self, id: &str, display_name: &str) -> Result<User, String> {
        let display_name = name(display_name)?;
        self.update(id, |user| {
            user.name = display_name;
            Ok(())
        })
    }

    pub(crate) fn set_role(&self, id: &str, role: Role) -> Result<User, String> {
        self.update(id, |user| {
            if user.role == Role::Owner || role == Role::Owner {
                return Err("The owner role cannot be changed or assigned".into());
            }
            user.role = role;
            Ok(())
        })
    }

    fn update(
        &self,
        id: &str,
        apply: impl FnOnce(&mut User) -> Result<(), String>,
    ) -> Result<User, String> {
        self.change(
            |error| error.to_string(),
            |members| {
                let user = &mut members
                    .iter_mut()
                    .find(|m| m.user.id == id && m.revoked_at.is_none())
                    .ok_or("Unknown member")?
                    .user;
                apply(user)?;
                Ok(user.clone())
            },
        )
    }

    fn change<T, E>(
        &self,
        store_error: impl FnOnce(io::Error) -> E,
        update: impl FnOnce(&mut Vec<Member>) -> Result<T, E>,
    ) -> Result<T, E> {
        let _writer = self.writer.lock().expect("members writer lock");
        let mut members = self.members.lock().expect("members lock");
        let mut next = members.clone();
        let result = update(&mut next)?;
        self.save(&next).map_err(store_error)?;
        *members = next;
        self.device_changes.send_replace(());
        Ok(result)
    }

    fn save(&self, members: &[Member]) -> io::Result<()> {
        use std::io::Write;
        // Check at the shared write boundary so startup and every update preserve ownership.
        let mut owners = members
            .iter()
            .filter(|member| member.user.role == Role::Owner);
        if owners.next().is_none_or(|owner| owner.revoked_at.is_some()) || owners.next().is_some() {
            return Err(io::Error::other(
                "The workspace must have exactly one active owner",
            ));
        }
        let Some(path) = &self.path else {
            return Ok(());
        };
        let directory = path.parent().expect("members directory");
        std::fs::create_dir_all(directory)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(&serde_json::to_vec_pretty(members)?)?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_members_sign_in_until_revoked_and_stay_revoked_across_restarts() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("members.json");
        let token = "legacy-test-device";
        std::fs::write(
            &path,
            serde_json::json!([{"id":"alice","name":"Alice","role":"member","created_at":1,
                "token_hash":hash(token)}])
            .to_string(),
        )
        .unwrap();
        let auth = Identities::hosted(path.clone(), "bootstrap", "Owner").unwrap();
        assert_eq!(auth.identify("bootstrap").unwrap().id, "owner");
        assert!(auth.identify("wrong").is_none());
        let user = auth.identify(token).unwrap();
        assert_eq!(user.name, "Alice");
        assert!(!std::fs::read_to_string(&path).unwrap().contains(token));
        assert!(!auth.list().to_string().contains("token_hash"));
        auth.revoke(&user.id).unwrap();
        assert!(auth.authenticate(token).is_none());
        let reopened = Identities::hosted(path, "bootstrap", "Owner").unwrap();
        assert!(reopened.identify(token).is_none());
        assert_eq!(reopened.identify("bootstrap").unwrap().role, Role::Owner);
        assert_eq!(Identities::local(None).identify("").unwrap().id, "local");
    }
}
