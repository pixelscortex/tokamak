use super::*;
use crate::identity::{AccountBinding, Identities, Role, User, register_caller};
use engine::PendingCall;

/// Outcomes safe for the HTTP adapter to expose without provider exception details.
pub(crate) enum SignInError {
    InvalidFields,
    Denied(String),
    Busy,
    Unavailable,
}

enum Entry {
    SignIn(String),
    CreateOwner(String),
    CreateAccount { method: String, member: String },
    ResetPassword(AccountBinding),
    ChangePassword(AccountBinding),
}

impl Entry {
    fn method(&self) -> &str {
        match self {
            Self::SignIn(id) | Self::CreateOwner(id) => id,
            Self::CreateAccount { method, .. } => method,
            Self::ResetPassword(binding) | Self::ChangePassword(binding) => &binding.method,
        }
    }

    fn resolve(
        self,
        method: crate::plugins::SignInMethod,
        fields: Json,
    ) -> Result<ProviderCall, SignInError> {
        let (form, address, member, binding) = match self {
            Self::SignIn(_) => (Some(method.form), Some(method.provider_action), None, None),
            Self::CreateOwner(_) => (
                method.setup_owner_form,
                method.setup_owner_action,
                None,
                None,
            ),
            Self::CreateAccount { member, .. } => (
                method.create_account_form,
                method.create_account_action,
                Some(member),
                None,
            ),
            Self::ResetPassword(binding) => {
                (None, method.reset_password_action, None, Some(binding))
            }
            Self::ChangePassword(binding) => {
                (None, method.change_password_action, None, Some(binding))
            }
        };
        if let Some(form) = form
            && !fields.as_object().is_some_and(|fields| {
                form.len() == fields.len() && form.keys().all(|key| fields[key].as_str().is_some())
            })
        {
            return Err(SignInError::InvalidFields);
        }
        let arguments = match member {
            Some(member) => serde_json::json!({"memberId": member, "fields": fields}),
            None => fields,
        };
        Ok(ProviderCall {
            method: method.id,
            address: address.ok_or(SignInError::Unavailable)?,
            arguments,
            plugin: binding.map(|binding| binding.plugin),
        })
    }
}

struct ProviderCall {
    method: String,
    address: String,
    arguments: Json,
    plugin: Option<String>,
}

struct Prepared {
    plugin: String,
    method: String,
    pending: PendingCall,
    cleanup: Option<MemberAccountCleanup>,
}

pub(crate) struct AuthenticatedAccount {
    pub binding: AccountBinding,
    pub display_name: Option<String>,
    pub password_change_required: bool,
    cleanup: Option<MemberAccountCleanup>,
}

pub(crate) struct MemberAccountCleanup {
    pub(super) generation: Arc<crate::plugins::Loaded>,
    pub(super) targets: Vec<String>,
}

pub(crate) struct SignInRequest {
    entry: Entry,
    fields: Json,
    reply: oneshot::Sender<Result<Prepared, SignInError>>,
}

impl Server {
    pub(crate) async fn run_sign_in(
        &self,
        method: String,
        fields: Json,
    ) -> Result<AuthenticatedAccount, SignInError> {
        self.call_sign_in(Entry::SignIn(method), fields).await
    }

    /// Call only after the HTTP adapter checks a lease granted by a bootstrap key exchange.
    pub(crate) async fn create_owner_account(
        &self,
        method: String,
        fields: Json,
    ) -> Result<AuthenticatedAccount, SignInError> {
        self.call_sign_in(Entry::CreateOwner(method), fields).await
    }

    pub(crate) async fn create_member_account(
        &self,
        identities: &Identities,
        method: String,
        fields: Json,
    ) -> Result<User, SignInError> {
        // Reserve a completion command before the provider can commit its write.
        let permit = self
            .commands
            .reserve()
            .await
            .map_err(|_| SignInError::Unavailable)?;
        let id = uuid::Uuid::new_v4().to_string();
        let account = self
            .call_sign_in(
                Entry::CreateAccount {
                    method,
                    member: id.clone(),
                },
                fields,
            )
            .await?;
        let cleanup = account.cleanup.ok_or(SignInError::Unavailable)?;
        let user = User {
            id,
            name: account.display_name.unwrap_or_default(),
            role: Role::Member,
        };
        let saved = !user.name.is_empty()
            && identities
                .add_member_account(user.clone(), account.binding)
                .is_ok();
        let (reply, wait) = oneshot::channel();
        if saved {
            permit.send(Command::MemberAdded(user.clone(), reply));
        } else {
            permit.send(Command::MemberAccountAbandoned {
                user: user.clone(),
                cleanup,
                reply,
            });
        }
        wait.await.map_err(|_| SignInError::Unavailable)?;
        saved.then_some(user).ok_or(SignInError::Unavailable)
    }

    pub(crate) async fn reset_member_password(
        &self,
        binding: AccountBinding,
        password: String,
    ) -> Result<(), SignInError> {
        let arguments = serde_json::json!({"accountId": binding.account, "password": password});
        self.rotate_password(Entry::ResetPassword(binding.clone()), &binding, arguments)
            .await
    }

    pub(crate) async fn change_temporary_password(
        &self,
        binding: AccountBinding,
        fields: Json,
        password: String,
    ) -> Result<(), SignInError> {
        let arguments = serde_json::json!({
            "accountId": binding.account, "fields": fields, "newPassword": password
        });
        self.rotate_password(Entry::ChangePassword(binding.clone()), &binding, arguments)
            .await
    }

    async fn rotate_password(
        &self,
        entry: Entry,
        expected: &AccountBinding,
        arguments: Json,
    ) -> Result<(), SignInError> {
        let result = self.call_sign_in(entry, arguments).await?;
        if &result.binding != expected || result.password_change_required {
            return Err(SignInError::Unavailable);
        }
        Ok(())
    }

    async fn call_sign_in(
        &self,
        entry: Entry,
        fields: Json,
    ) -> Result<AuthenticatedAccount, SignInError> {
        let (reply, wait) = oneshot::channel();
        admit(
            &self.commands,
            Command::RunSignIn(SignInRequest {
                entry,
                fields,
                reply,
            }),
        )
        .map_err(|error| match error {
            Error::Overloaded => SignInError::Busy,
            _ => SignInError::Unavailable,
        })?;
        let Prepared {
            plugin,
            method,
            pending,
            cleanup,
        } = wait.await.map_err(|_| SignInError::Unavailable)??;
        let result = pending.await.map_err(|_| SignInError::Unavailable)?;
        if result["failed"] == true {
            // Failure data and unrestricted kinds can contain submitted fields.
            let kind = result["kind"].as_str().filter(|kind| {
                !kind.is_empty()
                    && kind.len() <= 64
                    && kind.bytes().all(|b| b.is_ascii_alphanumeric())
            });
            return Err(SignInError::Denied(
                kind.unwrap_or("SignInFailed").to_owned(),
            ));
        }
        let account = result["accountId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or(SignInError::Unavailable)?
            .to_owned();
        let display_name = result["displayName"]
            .as_str()
            .and_then(|value| crate::identity::name(value).ok());
        Ok(AuthenticatedAccount {
            binding: AccountBinding {
                plugin,
                method,
                account,
            },
            display_name,
            password_change_required: result["passwordChangeRequired"] == true,
            cleanup,
        })
    }
}

impl Coordinator {
    pub(super) fn start_sign_in(&mut self, request: SignInRequest) {
        if !request.reply.is_closed() {
            let _ = request
                .reply
                .send(self.prepare_sign_in(request.entry, request.fields));
        }
    }

    fn prepare_sign_in(&mut self, entry: Entry, fields: Json) -> Result<Prepared, SignInError> {
        let loaded = self.plugins.clone().ok_or(SignInError::Unavailable)?;
        let methods = loaded
            .sign_in_methods()
            .map_err(|_| SignInError::Unavailable)?;
        let method = methods
            .into_iter()
            .find(|method| method.id == entry.method())
            .ok_or(SignInError::Unavailable)?;
        let provisioning = matches!(&entry, Entry::CreateAccount { .. });
        let call = entry.resolve(method, fields)?;
        let target = loaded
            .targets
            .get(&call.address)
            .filter(|target| {
                call.plugin
                    .as_ref()
                    .is_none_or(|plugin| *plugin == target.owner)
            })
            .ok_or(SignInError::Unavailable)?
            .clone();
        let cleanup = if provisioning {
            // Keep the cleanup from the same provider build even if a reload races the write.
            let targets =
                loaded.member_hooks(crate::plugins::MemberEvent::Removed, Some(&target.owner));
            if targets.is_empty() {
                return Err(SignInError::Unavailable);
            }
            Some(MemberAccountCleanup {
                generation: loaded.clone(),
                targets,
            })
        } else {
            None
        };
        // Put anonymous work on its own bounded lane so it cannot take up the
        // workers serving signed-in devices or inherit a session's authority.
        let pool = match &mut self.sign_in_pool {
            Some(pool) => pool,
            slot => slot.insert(
                Pool::new(PoolConfig {
                    workers: 2,
                    queue_capacity: 2,
                    limits: self.pool.limits().clone(),
                })
                .map_err(|_| SignInError::Unavailable)?,
            ),
        };

        let mut ops = OpRegistry::new();
        register_caller(None, &mut ops).map_err(|_| SignInError::Unavailable)?;
        engine::register_password_crypto(&mut ops).map_err(|_| SignInError::Unavailable)?;
        crate::actions::register_nested_calls(
            &mut ops,
            self.commands.clone(),
            Some(loaded),
            Some(target.owner.clone()),
            Arc::new(crate::environment::Snapshot::new(None, None)),
            None,
        )
        .map_err(|_| SignInError::Unavailable)?;
        let pending = pool
            .submit(
                target.bundle,
                "invoke",
                serde_json::json!({"name": target.local_name, "args": call.arguments}),
                Arc::new(ops),
            )
            .map_err(|error| match error {
                engine::Error::Overloaded => SignInError::Busy,
                _ => SignInError::Unavailable,
            })?;
        Ok(Prepared {
            plugin: target.owner,
            method: call.method,
            pending,
            cleanup,
        })
    }
}
