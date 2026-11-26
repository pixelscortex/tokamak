//! Static preflight, disk-backed immutable artifact snapshots and dependency routing.
use crate::{Error, data::DataSpace, service::Visibility};
use engine::Bundle;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct Artifact {
    pub manifest: Manifest,
    pub bundle: Option<Arc<Bundle>>,
    assets: BTreeMap<String, Arc<Asset>>,
    permissions: BTreeSet<String>,
    http_slots: Arc<std::sync::OnceLock<Arc<tokio::sync::Semaphore>>>,
}
pub struct Catalog {
    pub order: Vec<String>,
    pub plugins: BTreeMap<String, Arc<Artifact>>,
    pub revision: String,
    install_order: Vec<String>,
    folders: BTreeMap<String, PathBuf>,
    skipped: BTreeMap<String, catalog::ScanSkip>,
    plugins_folder: PathBuf,
    pub(crate) removed_plugins: Vec<String>,
    pub(crate) root: PathBuf,
    pub(crate) directory: PathBuf,
}

/// One immutable, fully inspected generation. Function lookup selects the owner;
/// neither request JSON nor JavaScript can choose a database namespace.
pub(crate) struct Loaded {
    pub catalog: Catalog,
    pub targets: BTreeMap<String, Target>,
    pub triggers: crate::host::triggers::TriggerRegistry,
    pub hooks: crate::host::hooks::HookRegistry,
    pub descriptor: Value,
    pub catalog_text: String,
    pub(crate) skipped: BTreeMap<String, String>,
    pub(crate) action_sources: BTreeMap<String, Arc<crate::host::action_process::Source>>,
    contracts: Contracts,
    pub(crate) transaction_bundles: BTreeMap<String, Arc<Bundle>>,
    inspected: BTreeMap<String, crate::service::InspectedBundle>,
}

#[derive(Clone)]
pub(crate) struct Target {
    pub owner: String,
    pub local_name: String,
    pub args: Arc<Value>,
    pub result: Option<Arc<Value>>,
    pub derived_result_warning: Option<Arc<std::sync::atomic::AtomicBool>>,
    pub points: Arc<BTreeMap<String, Point>>,
    pub mutation: bool,
    pub visibility: Visibility,
    pub kind: crate::service::FunctionKind,
    pub on: crate::protocol::ActionTarget,
    pub bundle: Arc<Bundle>,
    pub space: DataSpace,
}

#[derive(serde::Deserialize)]
pub(crate) struct Point {
    pub args: Value,
    pub result: Option<Value>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub(crate) struct Hook {
    pub owner: String,
    pub name: String,
    pub before: bool,
    pub after: bool,
}

impl Target {
    pub(crate) fn check_anonymous_scope(&self, provider: &str) -> Result<(), String> {
        if self.owner == provider && self.visibility == Visibility::Internal {
            Ok(())
        } else {
            Err("Anonymous calls can only access private functions of their provider".into())
        }
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

mod artifact;
mod assets;
mod catalog;
pub(crate) use catalog::runner_provider_routes;
mod contracts;
pub(crate) use contracts::LocalDataMethods;
pub(crate) use contracts::MemberEvent;
mod dependencies;
mod grants;
mod loading;
mod manifest;

pub use assets::Asset;
use assets::asset;
use contracts::Contracts;
pub(crate) use contracts::register_contract_list;
pub use contracts::{
    ContractDeclaration, ContractRegistration, ContractTarget, SignInField, SignInForm,
    SignInMethod,
};
use dependencies::resolve;
pub(crate) use loading::StartupPolicy;
pub use manifest::*;

#[cfg(test)]
mod tests;
