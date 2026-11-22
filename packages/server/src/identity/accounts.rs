use super::{Identities, Member, Role, User, name, now};
use serde::{Deserialize, Serialize};

/// Identifies an account within one installed sign-in provider and method.
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct AccountBinding {
    pub plugin: String,
    pub method: String,
    pub account: String,
}

impl Identities {
    pub(crate) fn account_member(&self, account: &AccountBinding) -> Option<String> {
        self.members
            .lock()
            .expect("members lock")
            .iter()
            .find(|member| member.revoked_at.is_none() && member.accounts.contains(account))
            .map(|member| member.user.id.clone())
    }

    pub(crate) fn add_member_account(
        &self,
        user: User,
        account: AccountBinding,
    ) -> Result<(), String> {
        self.change(
            |error| error.to_string(),
            |members| {
                if members
                    .iter()
                    .any(|member| member.user.id == user.id || member.accounts.contains(&account))
                {
                    return Err("Account already linked".into());
                }
                members.push(Member {
                    user,
                    token_hash: None,
                    devices: Vec::new(),
                    accounts: vec![account],
                    created_at: now(),
                    revoked_at: None,
                });
                Ok(())
            },
        )
    }

    pub(crate) fn member_account(&self, id: &str) -> Option<AccountBinding> {
        self.with_active(id, |member| member.accounts.first().cloned())
    }

    /// Whether the owner has no sign-in account bound to their profile.
    pub(crate) fn owner_needs_setup(&self) -> bool {
        self.members
            .lock()
            .expect("members lock")
            .iter()
            .any(|member| member.user.role == Role::Owner && member.accounts.is_empty())
    }

    pub(crate) fn bind_owner_account(
        &self,
        account: AccountBinding,
        display_name: Option<&str>,
    ) -> Result<User, String> {
        let display_name = display_name.map(name).transpose()?;
        self.change(
            |error| error.to_string(),
            |members| {
                if members
                    .iter()
                    .any(|member| member.accounts.contains(&account))
                {
                    return Err("Account already linked".into());
                }
                let owner = members
                    .iter_mut()
                    .find(|member| member.user.role == Role::Owner && member.accounts.is_empty())
                    .ok_or("Owner account is already set up")?;
                owner.accounts.push(account);
                if let Some(display_name) = display_name {
                    owner.user.name = display_name;
                }
                Ok(owner.user.clone())
            },
        )
    }
}
