//! Static preflight, disk-backed immutable artifact snapshots and dependency routing.
use crate::{Error, data::DataSpace};
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
    sync::{Arc, Weak},
};

pub struct Artifact {
    pub manifest: Manifest,
    pub(crate) build_id: String,
    source: PathBuf,
    pub bundle: Option<Arc<Bundle>>,
    assets: BTreeMap<String, Arc<Asset>>,
    provides: BTreeSet<String>,
    consumes: BTreeSet<String>,
    permissions: BTreeSet<String>,
}
pub struct Catalog {
    pub order: Vec<String>,
    pub plugins: BTreeMap<String, Arc<Artifact>>,
    pub revision: String,
    providers: BTreeMap<String, Vec<String>>,
    pub(crate) index: Arc<BTreeMap<String, PathBuf>>,
    installed: BTreeMap<String, PathBuf>,
    index_path: Option<PathBuf>,
    pub(crate) package_root: Option<PathBuf>,
    pub(crate) environment: PathBuf,
    pub(crate) directory: PathBuf,
}

/// One immutable, fully inspected generation. Function lookup selects the owner;
/// neither request JSON nor JavaScript can choose a database namespace.
pub(crate) struct Loaded {
    pub catalog: Catalog,
    pub targets: BTreeMap<String, Target>,
    pub descriptor: Value,
    pub catalog_revision: String,
    pub catalog_text: String,
    pub(crate) logs: BTreeMap<String, crate::plugin_log::Log>,
    pub(crate) skipped: BTreeMap<String, String>,
    pub(crate) workers: BTreeMap<String, Arc<crate::host::worker::Supervisor>>,
    pub(crate) action_lifetimes: BTreeMap<String, tokio_util::sync::CancellationToken>,
    current: Arc<tokio::sync::RwLock<Weak<Self>>>,
    inspected: BTreeMap<String, (Value, BTreeMap<String, crate::service::FunctionKind>)>,
}

#[derive(Clone)]
pub(crate) struct Target {
    pub owner: String,
    pub local_name: String,
    pub mutation: bool,
    pub kind: crate::service::FunctionKind,
    pub bundle: Arc<Bundle>,
    pub space: DataSpace,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

mod artifact;
mod assets;
mod catalog;
mod dependencies;
mod grants;
mod loading;
mod manifest;
pub(crate) mod package;

pub use assets::Asset;
use assets::asset;
use dependencies::resolve;
pub use manifest::*;

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexedBuild {
    pub id: String,
    pub build_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexedReload {
    pub builds: Vec<IndexedBuild>,
    pub remove_missing: bool,
}
