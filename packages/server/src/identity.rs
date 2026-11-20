//! Temporary invite identities. Replace this module when real accounts arrive.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io, path::PathBuf, sync::Mutex, time::SystemTime};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

mod cli;
pub use cli::revoke;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub name: String,
    pub role: String,
}

impl User {
    pub fn local() -> Self {
        Self {
            id: "local".into(),
            name: std::env::var("TOKAMAK_OWNER_NAME").unwrap_or_else(|_| "You".into()),
            role: "owner".into(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Member {
    #[serde(flatten)]
    pub user: User,
    token_hash: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<u64>,
    #[serde(skip)]
    cancelled: CancellationToken,
}

pub struct Identities {
    path: Option<PathBuf>,
    members: Mutex<Vec<Member>>,
    anonymous: bool,
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
        let identities = Self::local(Some(token));
        {
            let mut members = identities.members.lock().expect("members lock");
            members[0].user.id = "owner".into();
            members[0].user.name =
                std::env::var("TOKAMAK_OWNER_NAME").unwrap_or_else(|_| "Owner".into());
        }
        identities
    }
    pub fn local(token: Option<&str>) -> Self {
        Self {
            path: None,
            members: Mutex::new(vec![Member {
                user: User::local(),
                token_hash: hash(token.unwrap_or_default()),
                created_at: now(),
                revoked_at: None,
                cancelled: CancellationToken::new(),
            }]),
            anonymous: token.is_none(),
        }
    }

    pub fn hosted(path: PathBuf, token: &str, owner_name: &str) -> io::Result<Self> {
        Self::persistent(
            path,
            token,
            User {
                id: "owner".into(),
                name: owner_name.into(),
                role: "owner".into(),
            },
        )
    }

    pub fn local_members(directory: &std::path::Path, token: &str) -> io::Result<Self> {
        Self::persistent(directory.join("members.json"), token, User::local())
    }

    fn persistent(path: PathBuf, token: &str, mut user: User) -> io::Result<Self> {
        let mut members: Vec<Member> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        if let Some(owner) = members.iter_mut().find(|m| m.user.id == user.id) {
            owner.token_hash = hash(token);
            owner.revoked_at = None;
        } else {
            if user.id == "owner" {
                user.name = name(&user.name).map_err(io::Error::other)?;
            }
            members.push(Member {
                user,
                token_hash: hash(token),
                created_at: now(),
                revoked_at: None,
                cancelled: CancellationToken::new(),
            });
        }
        let identities = Self {
            path: Some(path),
            members: Mutex::new(members),
            anonymous: false,
        };
        identities.save(&identities.members.lock().expect("members lock"))?;
        Ok(identities)
    }

    /// The single token-to-user boundary for hosted and local connections.
    pub fn identify(&self, token: &str) -> Option<User> {
        let actual = hash(token);
        let members = self.members.lock().expect("members lock");
        let mut found = None;
        for member in members.iter() {
            let matches = bool::from(actual.as_bytes().ct_eq(member.token_hash.as_bytes()));
            if (matches || self.anonymous) && member.revoked_at.is_none() {
                found = Some(member.user.clone());
            }
        }
        found
    }

    pub fn cancellation(&self, id: &str) -> CancellationToken {
        let members = self.members.lock().expect("members lock");
        let member = members
            .iter()
            .find(|m| m.user.id == id)
            .expect("identified member");
        if member.revoked_at.is_some() {
            member.cancelled.cancel();
        }
        member.cancelled.clone()
    }

    pub fn list(&self) -> serde_json::Value {
        serde_json::Value::Array(self.members.lock().expect("members lock").iter().map(|m| {
            serde_json::json!({"id":m.user.id,"name":m.user.name,"role":m.user.role,"created_at":m.created_at,"revoked_at":m.revoked_at})
        }).collect())
    }

    pub fn invite(&self, display_name: &str) -> Result<String, String> {
        let display_name = name(display_name)?;
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        // Hex is URL-safe and retains all 256 random bits.
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.change(|members| {
            members.push(Member {
                user: User {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: display_name,
                    role: "member".into(),
                },
                token_hash: hash(&token),
                created_at: now(),
                revoked_at: None,
                cancelled: CancellationToken::new(),
            });
            Ok(())
        })?;
        Ok(token)
    }

    pub fn revoke(&self, id: &str) -> Result<(), String> {
        if id == "owner" || id == "local" {
            return Err("The bootstrap owner cannot be revoked".into());
        }
        self.change(|members| {
            let member = members
                .iter_mut()
                .find(|m| m.user.id == id)
                .ok_or("Unknown member")?;
            member.revoked_at = Some(now());
            Ok(())
        })?;
        self.cancellation(id).cancel();
        Ok(())
    }

    pub fn rename(&self, id: &str, display_name: &str) -> Result<User, String> {
        let display_name = name(display_name)?;
        self.change(|members| {
            let member = members
                .iter_mut()
                .find(|m| m.user.id == id && m.revoked_at.is_none())
                .ok_or("Unknown member")?;
            member.user.name = display_name;
            Ok(member.user.clone())
        })
    }

    fn change<T>(
        &self,
        update: impl FnOnce(&mut Vec<Member>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut members = self.members.lock().expect("members lock");
        let mut next = members.clone();
        let result = update(&mut next)?;
        self.save(&next).map_err(|e| e.to_string())?;
        *members = next;
        Ok(result)
    }

    fn save(&self, members: &[Member]) -> io::Result<()> {
        use std::io::Write;
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
    fn identifies_bootstrap_invites_and_revocations_across_restarts() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("members.json");
        let auth = Identities::hosted(path.clone(), "bootstrap", "Owner").unwrap();
        assert_eq!(auth.identify("bootstrap").unwrap().id, "owner");
        assert!(auth.identify("wrong").is_none());
        let token = auth.invite("Alice").unwrap();
        let user = auth.identify(&token).unwrap();
        assert_eq!(user.name, "Alice");
        assert!(!std::fs::read_to_string(&path).unwrap().contains(&token));
        assert!(!auth.list().to_string().contains("token_hash"));
        let cancelled = auth.cancellation(&user.id);
        auth.revoke(&user.id).unwrap();
        assert!(cancelled.is_cancelled());
        assert!(auth.identify(&token).is_none());
        let reopened = Identities::hosted(path, "bootstrap", "Owner").unwrap();
        assert!(reopened.identify(&token).is_none());
        assert_eq!(reopened.identify("bootstrap").unwrap().role, "owner");
        assert_eq!(Identities::local(None).identify("").unwrap().id, "local");
    }
}
