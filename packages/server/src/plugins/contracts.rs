//! Provider addresses are minted by the build and reachable only by the
//! defining plugin. They never enter the window's function registry.
use super::*;

pub(crate) const AUTH_CONTRACT_OWNER: &str = "auth";
const SIGN_IN_CONTRACT: &str = "method";
const SIGN_IN_METHOD: &str = "signIn";
const SETUP_OWNER: &str = "setupOwner";
const CREATE_ACCOUNT: &str = "createAccount";
const RESET_PASSWORD: &str = "resetPassword";
const CHANGE_PASSWORD: &str = "changePassword";
const RUN: &str = "run";

pub type SignInForm = BTreeMap<String, SignInField>;

#[derive(Clone, Copy)]
pub(crate) enum MemberEvent {
    Added,
    Removed,
}

impl MemberEvent {
    const ALL: [Self; 2] = [Self::Added, Self::Removed];

    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Added => "memberAdded",
            Self::Removed => "memberRemoved",
        }
    }
}

/// A method the core can resolve before creating a session.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInMethod {
    pub id: String,
    pub name: String,
    pub form: SignInForm,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_owner_form: Option<SignInForm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_account_form: Option<SignInForm>,
    #[serde(skip)]
    pub(crate) login_field: Option<String>,
    /// Internal action address. Re-resolve against the live catalog at sign-in.
    #[serde(skip)]
    pub provider_action: String,
    #[serde(skip)]
    pub(crate) setup_owner_action: Option<String>,
    #[serde(skip)]
    pub(crate) create_account_action: Option<String>,
    #[serde(skip)]
    pub(crate) reset_password_action: Option<String>,
    #[serde(skip)]
    pub(crate) change_password_action: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignInField {
    Text,
    Email,
    Password,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContractTarget {
    Caller,
    Server,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractDeclaration {
    pub name: String,
    pub on: ContractTarget,
    pub declaration_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_methods: Option<LocalDataMethods>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum LocalDataMethods {
    All(bool),
    Named(Vec<String>),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractRegistration {
    pub owner: String,
    pub name: String,
    pub on: ContractTarget,
    pub declaration_hash: String,
    pub registration: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_methods: Option<LocalDataMethods>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,
    pub methods: BTreeMap<String, String>,
}

impl ContractRegistration {
    pub(super) fn is_sign_in(&self) -> bool {
        self.owner == AUTH_CONTRACT_OWNER && self.name == SIGN_IN_CONTRACT
    }
}

#[derive(Serialize)]
pub(crate) struct ServerProvider {
    id: String,
    data: Value,
    methods: BTreeMap<String, String>,
}

pub(crate) type Contracts = BTreeMap<(String, String), Vec<ServerProvider>>;
type Declarations<'a> = BTreeMap<(&'a str, &'a str), (ContractTarget, &'a str)>;

pub(super) struct ContractLoadError {
    pub error: Error,
    pub auth_provider: Option<String>,
}

impl Loaded {
    pub(super) fn load_contracts(&self) -> Result<Contracts, ContractLoadError> {
        let built_in_hash = format!(
            "{:x}",
            Sha256::digest(include_bytes!("../../../sdk/core-contracts/auth.ts"))
        );
        let mut declarations: Declarations<'_> = std::iter::once(SIGN_IN_CONTRACT)
            .chain(MemberEvent::ALL.map(MemberEvent::name))
            .map(|name| {
                (
                    (AUTH_CONTRACT_OWNER, name),
                    (ContractTarget::Server, built_in_hash.as_str()),
                )
            })
            .collect();
        for (owner, artifact) in &self.catalog.plugins {
            for declaration in &artifact.manifest.contracts {
                declarations.insert(
                    (owner, &declaration.name),
                    (declaration.on, &declaration.declaration_hash),
                );
            }
        }
        let mut contracts = declarations
            .iter()
            .filter(|(_, (place, _))| *place == ContractTarget::Server)
            .map(|((owner, name), _)| ((owner.to_string(), name.to_string()), Vec::new()))
            .collect::<Contracts>();
        for (plugin, artifact) in &self.catalog.plugins {
            for registration in &artifact.manifest.contract_providers {
                self.load_contract_provider(plugin, registration, &declarations, &mut contracts)
                    .map_err(|error| ContractLoadError {
                        error,
                        auth_provider: (registration.owner == AUTH_CONTRACT_OWNER)
                            .then(|| plugin.clone()),
                    })?;
            }
        }
        Ok(contracts)
    }

    fn load_contract_provider(
        &self,
        plugin: &str,
        registration: &ContractRegistration,
        declarations: &Declarations<'_>,
        contracts: &mut Contracts,
    ) -> Result<(), Error> {
        let owner = registration.owner.as_str();
        let name = registration.name.as_str();
        if owner != AUTH_CONTRACT_OWNER && !self.catalog.plugins.contains_key(owner) {
            return Ok(()); // An optional owner can be installed after its providers.
        }
        let declaration = declarations.get(&(owner, name));
        if declaration.is_some_and(|(place, _)| *place == ContractTarget::Caller)
            && registration.on == ContractTarget::Caller
        {
            // The client lists local providers and quarantines stale builds there.
            // One mismatched local provider must not prevent catalog publication.
            return Ok(());
        }
        if declaration != Some(&(registration.on, registration.declaration_hash.as_str())) {
            return Err(invalid(format!(
                "Contract declaration mismatch for {owner}/{name} in {plugin}; rebuild against the owner's public declaration"
            )));
        }
        let providers = contracts
            .get_mut(&(owner.to_owned(), name.to_owned()))
            .expect("checked server contract declaration");
        let provider = self.read_provider(plugin, registration)?;
        if providers.iter().any(|current| current.id == provider.id) {
            return Err(invalid(format!(
                "Duplicate provider {} for {owner}/{name}",
                provider.id,
            )));
        }
        providers.push(provider);
        Ok(())
    }

    fn read_provider(
        &self,
        plugin: &str,
        registration: &ContractRegistration,
    ) -> Result<ServerProvider, Error> {
        let data = self
            .inspected
            .get(plugin)
            .and_then(|bundle| {
                bundle.descriptor["contractProviders"].get(&registration.registration)
            })
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                invalid(format!(
                    "Missing server contract provider data: {plugin}/{}",
                    registration.registration
                ))
            })?;
        let id = match data.get("id") {
            Some(value) => value
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("Contract provider id must be a nonempty string"))?,
            None => plugin,
        };
        let sign_in = registration.is_sign_in();
        let member_hook = registration.owner == AUTH_CONTRACT_OWNER
            && MemberEvent::ALL
                .iter()
                .any(|event| event.name() == registration.name);
        if member_hook
            && (registration.methods.len() != 1 || !registration.methods.contains_key(RUN))
        {
            return Err(invalid(
                "An auth member hook requires one internal mutation",
            ));
        }
        let methods = registration
            .methods
            .iter()
            .map(|(member, name)| {
                let qualified = format!("{plugin}/{name}");
                let registered = self.targets.get(&qualified).is_some_and(|target| {
                    if sign_in {
                        self.private_action(target)
                    } else if member_hook {
                        self.private_function(target)
                            && target.kind == crate::service::FunctionKind::Mutation
                    } else {
                        self.private_function(target)
                    }
                });
                if !registered {
                    return Err(invalid(format!(
                        "Contract method is not private: {qualified}"
                    )));
                }
                Ok((member.clone(), qualified))
            })
            .collect::<Result<_, Error>>()?;
        let provider = ServerProvider {
            id: id.into(),
            data: data.clone(),
            methods,
        };
        if sign_in {
            provider.sign_in_method()?;
        }
        Ok(provider)
    }

    pub(crate) fn sign_in_methods(&self) -> Result<Vec<SignInMethod>, Error> {
        self.contracts
            .get(&(AUTH_CONTRACT_OWNER.to_owned(), SIGN_IN_CONTRACT.to_owned()))
            .into_iter()
            .flatten()
            .map(ServerProvider::sign_in_method)
            .collect()
    }

    pub(crate) fn member_hooks(&self, event: MemberEvent, plugin: Option<&str>) -> Vec<String> {
        self.contracts
            .get(&(AUTH_CONTRACT_OWNER.to_owned(), event.name().to_owned()))
            .into_iter()
            .flatten()
            .filter_map(|provider| provider.methods.get(RUN))
            .filter(|target| {
                plugin.is_none_or(|plugin| {
                    self.targets
                        .get(*target)
                        .is_some_and(|target| target.owner == plugin)
                })
            })
            .cloned()
            .collect()
    }

    fn private_function(&self, target: &Target) -> bool {
        target.visibility == Visibility::Internal && !self.scheduler_only(target)
    }

    fn private_action(&self, target: &Target) -> bool {
        self.private_function(target) && target.kind == crate::service::FunctionKind::Action
    }

    pub(crate) fn contract_providers(
        &self,
        caller: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        if payload
            .get("owner")
            .is_some_and(|owner| owner.as_str() != Some(caller))
        {
            return Err("Only the defining plugin can list contract providers".into());
        }
        let name = payload["name"].as_str().ok_or("Contract requires a name")?;
        self.contracts
            .get(&(caller.to_owned(), name.to_owned()))
            .map(|providers| json!(providers))
            .ok_or_else(|| format!("Unknown server contract: {caller}/{name}"))
    }

    pub(super) fn is_contract_method(&self, owner: &str, name: &str, target: &str) -> bool {
        self.contracts
            .get(&(owner.to_owned(), name.to_owned()))
            .is_some_and(|providers| {
                providers
                    .iter()
                    .any(|provider| provider.methods.values().any(|method| method == target))
            })
    }
}

impl ServerProvider {
    fn sign_in_method(&self) -> Result<SignInMethod, Error> {
        let error = |message: &str| invalid(format!("auth.method provider {}: {message}", self.id));
        let name = self.data["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| error("requires a name"))?
            .to_owned();
        let form = serde_json::from_value::<SignInForm>(self.data["form"].clone())
            .map_err(|_| error("requires a form with text, email or password fields"))?;
        let login_field = match self.data.get("loginField") {
            Some(field) => Some(
                field
                    .as_str()
                    .filter(|field| {
                        matches!(
                            form.get(*field),
                            Some(SignInField::Text | SignInField::Email)
                        )
                    })
                    .ok_or_else(|| error("loginField must name a text or email field"))?
                    .to_owned(),
            ),
            None => form
                .iter()
                .find(|(_, kind)| matches!(kind, SignInField::Text | SignInField::Email))
                .map(|(field, _)| field.clone()),
        };
        let provisioning = |member: &str, form: &str| {
            let action = self.methods.get(member).cloned();
            match (action, self.data.get(form)) {
                (Some(action), Some(fields)) => Ok((
                    Some(action),
                    Some(serde_json::from_value(fields.clone()).map_err(|_| {
                        error(&format!(
                            "requires a {form} with text, email or password fields"
                        ))
                    })?),
                )),
                (None, None) => Ok((None, None)),
                _ => Err(error(&format!("requires {member} and {form} together"))),
            }
        };
        let (setup_owner_action, setup_owner_form) = provisioning(SETUP_OWNER, "setupOwnerForm")?;
        let (create_account_action, create_account_form) =
            provisioning(CREATE_ACCOUNT, "createAccountForm")?;
        let reset_password_action = self.methods.get(RESET_PASSWORD).cloned();
        let change_password_action = self.methods.get(CHANGE_PASSWORD).cloned();
        if (create_account_action.is_some() || reset_password_action.is_some())
            && change_password_action.is_none()
        {
            return Err(error(
                "requires changePassword to manage temporary passwords",
            ));
        }
        let provider_action = self
            .methods
            .get(SIGN_IN_METHOD)
            .ok_or_else(|| error("requires an internal signIn action"))?
            .clone();
        Ok(SignInMethod {
            id: self.id.clone(),
            name,
            form,
            provider_action,
            login_field,
            setup_owner_action,
            setup_owner_form,
            create_account_form,
            create_account_action,
            reset_password_action,
            change_password_action,
        })
    }
}

pub(crate) fn register_contract_list(
    ops: &mut engine::OpRegistry,
    generation: Arc<Loaded>,
    caller: String,
) -> Result<(), engine::Error> {
    ops.register_sync("contract.list", move |payload| {
        generation.contract_providers(&caller, &payload)
    })
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Manifest {
    pub(super) fn validate_contracts(&self) -> Result<(), Error> {
        let valid_name = |name: &str| {
            name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        };
        let mut declarations = BTreeSet::new();
        for contract in &self.contracts {
            if !valid_name(&contract.name)
                || !valid_hash(&contract.declaration_hash)
                || !declarations.insert(&contract.name)
            {
                return Err(invalid("Invalid contract declaration"));
            }
        }
        let mut registrations = BTreeSet::new();
        for provider in &self.contract_providers {
            let declared = self.plugin.declares_access_to(&provider.owner);
            let has_entry = match provider.on {
                ContractTarget::Caller => {
                    self.entries.local.is_some() && provider.methods.is_empty()
                }
                ContractTarget::Server => {
                    self.entries.server.is_some() && provider.unavailable.is_none()
                }
            };
            if !declared
                || !has_entry
                || !valid_name(&provider.name)
                || !valid_hash(&provider.declaration_hash)
                || provider.registration.is_empty()
                || provider
                    .unavailable
                    .as_ref()
                    .is_some_and(|notice| notice.is_empty() || notice.len() > 1024)
                || !registrations.insert(&provider.registration)
                || provider.methods.keys().any(|member| !valid_name(member))
            {
                return Err(invalid(format!(
                    "Invalid contract provider for {}/{}",
                    provider.owner, provider.name
                )));
            }
        }
        Ok(())
    }
}
