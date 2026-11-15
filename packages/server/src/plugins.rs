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
    sync::Arc,
};

fn host_api() -> String {
    "tokamak@^0.1".into()
}
fn hub() -> String {
    "hub".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub id: String,
    pub version: String,
    #[serde(default = "host_api")]
    pub api: String,
    #[serde(default)]
    pub depends: BTreeMap<String, String>,
    #[serde(default)]
    pub optional: BTreeMap<String, String>,
    #[serde(default)]
    pub breaks: BTreeMap<String, String>,
    #[serde(default)]
    pub provides: Vec<String>,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default = "hub")]
    pub placement: String,
    #[serde(default)]
    pub contributes: BTreeMap<String, Vec<Value>>,
    #[serde(default)]
    pub exports: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BackendEntry {
    pub code: String,
    pub map: String,
    pub api: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UiEntry {
    pub code: String,
    pub map: String,
    pub css: String,
    pub shell: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entries {
    #[serde(default)]
    pub backend: Option<BackendEntry>,
    #[serde(default)]
    pub ui: Option<UiEntry>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u32,
    pub plugin: Definition,
    pub entries: Entries,
    #[serde(default)]
    pub public_functions: BTreeSet<String>,
    pub hashes: BTreeMap<String, String>,
}

pub struct Artifact {
    pub manifest: Manifest,
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
}

/// One immutable, fully inspected generation. Function lookup selects the owner;
/// neither request JSON nor JavaScript can choose a database namespace.
pub(crate) struct Loaded {
    pub catalog: Catalog,
    pub targets: BTreeMap<String, Target>,
    pub descriptor: Value,
    pub catalog_text: String,
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
impl Loaded {
    pub async fn record_grants(
        &self,
        database: &crate::data::Database,
        previous: Option<&Self>,
    ) -> Result<(), Error> {
        use crate::data::{DataSpace, Id, Table, json_object};
        let table = DataSpace::plugin("tokamak.host")
            .map_err(|e| invalid(e.to_string()))?
            .table(&Table::new("grants").map_err(|e| invalid(e.to_string()))?)
            .map_err(|e| invalid(e.to_string()))?;
        let mut tx = Box::pin(database.begin())
            .await
            .map_err(|e| invalid(e.to_string()))?;
        let result = async {
            // Install every schema before writing grants. A failure rolls back
            // all catalog changes and grants for the candidate generation.
            for (id, (descriptor, _)) in &self.inspected {
                let schema = crate::schema::Schema::parse(&descriptor["schema"])?;
                let space = DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
                Box::pin(schema.apply(&mut tx, &space)).await?;
            }
            let mut granted = Vec::new();
            for id in &self.catalog.order {
                let definition = &self.catalog.plugins[id].manifest.plugin;
                let mut permissions = definition.permissions.clone();
                permissions.sort();
                if previous.and_then(|old| old.catalog.plugins.get(id)).is_some_and(|old| {
                    let mut granted = old.manifest.plugin.permissions.clone();
                    granted.sort();
                    old.manifest.plugin.version == definition.version && granted == permissions
                }) { continue; }
                let key = format!("{id}@{}",definition.version);
                let record_id = Id::new(table.clone(),format!("{:x}",Sha256::digest(key.as_bytes())))
                    .map_err(|e| invalid(e.to_string()))?;
                let existing = Box::pin(tx.get(&record_id))
                .await
                .map_err(|e| invalid(e.to_string()))?;
                if let Some(record) = existing.map(|row| row.into_json()) {
                    if record["permissions"] != json!(permissions) {
                        return Err(invalid(format!(
                            "Permissions changed for {id}@{}; bump its version before granting",
                            definition.version
                        )));
                    }
                    continue;
                }
                let record = json_object(
                    &json!({"key":key,"plugin":id,"version":definition.version,"permissions":permissions,
                    "policy":"trusted-local-auto-grant"}),
                )
                .map_err(|e| invalid(e.to_string()))?;
                Box::pin(tx.insert_keyed(&record_id, record))
                    .await
                    .map_err(|e| invalid(e.to_string()))?;
                granted.push((id.clone(), definition.version.clone(), permissions.len()));
            }
            Ok(granted)
        }
        .await;
        match result {
            Ok(granted) => {
                Box::pin(tx.commit())
                    .await
                    .map_err(|e| invalid(e.to_string()))?;
                for (id, version, count) in granted {
                    eprintln!(
                        "Auto-granted {count} declared capabilities to {id}@{version} (trusted local plugins)"
                    );
                }
                Ok(())
            }
            Err(error) => {
                Box::pin(tx.rollback())
                    .await
                    .map_err(|e| invalid(format!("{error}; grant rollback failed: {e}")))?;
                Err(error)
            }
        }
    }

    pub async fn load(catalog: Catalog, pool: &engine::Pool) -> Result<Arc<Self>, Error> {
        Self::load_reusing(catalog, pool, None).await
    }
    pub async fn load_reusing(
        catalog: Catalog,
        pool: &engine::Pool,
        previous: Option<&Self>,
    ) -> Result<Arc<Self>, Error> {
        let mut targets = BTreeMap::new();
        let mut functions = Vec::new();
        let mut inspected = BTreeMap::new();
        for id in &catalog.order {
            let artifact = &catalog.plugins[id];
            let Some(bundle) = &artifact.bundle else {
                continue;
            };
            let cached = previous
                .filter(|old| {
                    old.catalog
                        .plugins
                        .get(id)
                        .and_then(|p| p.bundle.as_ref())
                        .is_some_and(|b| Arc::ptr_eq(b, bundle))
                })
                .and_then(|old| old.inspected.get(id));
            let (descriptor, kinds) = match cached {
                Some(value) => value.clone(),
                None => crate::service::inspect(pool, bundle.clone()).await?,
            };
            inspected.insert(id.clone(), (descriptor.clone(), kinds.clone()));
            for name in &artifact.manifest.public_functions {
                if !kinds.contains_key(name) {
                    return Err(invalid(format!(
                        "Exported function {name} is not a backend function of {id}"
                    )));
                }
            }
            for (local_name, kind) in kinds {
                let name = format!("{id}/{local_name}");
                targets.insert(
                    name,
                    Target {
                        owner: id.clone(),
                        local_name,
                        mutation: kind == crate::service::FunctionKind::Mutation,
                        kind,
                        bundle: bundle.clone(),
                        space: DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?,
                    },
                );
            }
            for mut function in descriptor["functions"]
                .as_array()
                .expect("inspected")
                .clone()
            {
                function["name"] =
                    format!("{id}/{}", function["name"].as_str().expect("inspected")).into();
                functions.push(function);
            }
        }
        // Keep logical table names scoped by plugin in the aggregate metadata.
        let schemas: BTreeMap<_, _> = inspected
            .iter()
            .map(|(id, (descriptor, _))| (id.clone(), descriptor["schema"].clone()))
            .collect();
        let descriptor = json!({"schema":schemas,"functions":functions});
        let mut metadata = catalog.metadata();
        metadata["functions"] = descriptor["functions"].clone();
        metadata["schema"] = descriptor["schema"].clone();
        let catalog_text = serde_json::to_string(&metadata).map_err(|e| invalid(e.to_string()))?;
        Ok(Arc::new(Self {
            catalog,
            targets,
            descriptor,
            catalog_text,
            inspected,
        }))
    }

    pub fn target(
        &self,
        caller: &str,
        name: &str,
        writable: bool,
        path: &[String],
    ) -> Result<Target, String> {
        let target = self
            .targets
            .get(name)
            .ok_or_else(|| format!("Unknown plugin function: {name}"))?;
        if !self.catalog.can_call(caller, &target.owner) {
            return Err(format!(
                "{caller} does not declare access to {}",
                target.owner
            ));
        }
        let manifest = &self.catalog.plugins[&target.owner].manifest;
        if caller != target.owner
            && (manifest.plugin.exports.is_none()
                || !manifest.public_functions.contains(&target.local_name))
        {
            return Err(format!(
                "{} is not exported by {}",
                target.local_name, target.owner
            ));
        }
        if target.kind == crate::service::FunctionKind::Action {
            return Err("Queries and mutations cannot call actions".into());
        }
        if target.mutation && !writable {
            return Err("Queries cannot call mutations".into());
        }
        if path.iter().any(|entry| entry == name) {
            return Err("Plugin call cycle".into());
        }
        Ok(target.clone())
    }
}
fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

/// Verified private spool file: disk usage follows the installation, while each
/// transfer reads a bounded chunk. Never reopen mutable build output on requests.
pub struct Asset {
    path: Arc<tempfile::TempPath>,
    source: SourceStamp,
    pub len: u64,
}
/// Reuse a verified immutable snapshot only while file identity and change
/// metadata match. In-place writes and atomic replacements invalidate the stamp.
#[derive(PartialEq, Eq)]
struct SourceStamp {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}
impl SourceStamp {
    fn read(path: &Path, file: &File) -> Result<Self, Error> {
        let metadata = file.metadata().map_err(|e| invalid(e.to_string()))?;
        Ok(Self {
            path: path.to_owned(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        })
    }
}
impl Asset {
    pub fn read(&self, offset: u64, maximum: usize) -> Result<Vec<u8>, Error> {
        if offset > self.len {
            return Err(invalid("Invalid asset offset"));
        }
        let count = (self.len - offset).min(maximum as u64) as usize;
        let mut bytes = vec![0; count];
        let mut file = File::open(&*self.path).map_err(|e| invalid(e.to_string()))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| invalid(e.to_string()))?;
        file.read_exact(&mut bytes)
            .map_err(|e| invalid(e.to_string()))?;
        Ok(bytes)
    }
    pub fn page(&self, offset: u64) -> Result<Value, Error> {
        let bytes = self.read(offset, 8192)?;
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(error)
                if error.error_len().is_none() && offset + (bytes.len() as u64) < self.len =>
            {
                std::str::from_utf8(&bytes[..error.valid_up_to()])
                    .map_err(|e| invalid(e.to_string()))?
            }
            Err(_) => {
                return Err(invalid(
                    "Invalid asset offset or plugin UI asset is not UTF-8",
                ));
            }
        };
        let next = offset + text.len() as u64;
        Ok(json!({"text":text,"next":next,"done":next == self.len}))
    }
    fn check_backend_size(name: &str, len: u64) -> Result<(), Error> {
        // QuickJS compiles a complete module, and sourcemap builds a complete
        // index. Neither API accepts incremental input, so these cannot page.
        // UI and all other files use the disk spool without a file-size limit.
        const BACKEND_BYTES: u64 = 512 * 1024 * 1024;
        if len > BACKEND_BYTES {
            return Err(invalid(format!(
                "Backend code/source map {name} exceeds 512 MiB; QuickJS and the source-map index require whole-module memory. Split the backend into plugins."
            )));
        }
        Ok(())
    }
    fn backend_text(&self, name: &str) -> Result<String, Error> {
        Self::check_backend_size(name, self.len)?;
        String::from_utf8(self.read(0, self.len as usize)?).map_err(|e| invalid(e.to_string()))
    }
}
fn asset(
    root: &Path,
    name: &str,
    hashes: &BTreeMap<String, String>,
    previous: Option<&Artifact>,
    whole_backend: bool,
) -> Result<Arc<Asset>, Error> {
    let relative = Path::new(name);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(invalid("Artifact paths must stay inside their directory"));
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|e| invalid(e.to_string()))?;
    if !path.starts_with(root) {
        return Err(invalid("Artifact symlink escapes its directory"));
    }
    let expected = hashes
        .get(name)
        .ok_or_else(|| invalid(format!("Artifact has no hash for {name}; rebuild it")))?;
    let reusable = previous
        .filter(|p| p.manifest.hashes.get(name) == Some(expected))
        .and_then(|p| p.assets.get(name));
    let mut source =
        File::open(&path).map_err(|e| invalid(format!("Read {}: {e}", path.display())))?;
    let stamp = SourceStamp::read(&path, &source)?;
    if whole_backend {
        Asset::check_backend_size(name, stamp.len)?;
    }
    // Only Unix supplies stable file identity AND change time through std.
    // Other platforms conservatively rehash rather than trusting a restorable
    // modification timestamp. Missing timestamps also disable this fast path.
    #[cfg(unix)]
    if let Some(previous) = reusable {
        if stamp.modified.is_some() && previous.source == stamp {
            return Ok(previous.clone());
        }
    }
    let mut snapshot = if reusable.is_none() {
        Some(tempfile::NamedTempFile::new().map_err(|e| invalid(e.to_string()))?)
    } else {
        None
    };
    let mut hash = Sha256::new();
    let mut len = 0;
    // The copy/hash buffer bounds memory, never the accepted file size.
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|e| invalid(e.to_string()))?;
        if count == 0 {
            break;
        }
        if whole_backend {
            Asset::check_backend_size(name, len + count as u64)?;
        }
        hash.update(&buffer[..count]);
        if let Some(file) = &mut snapshot {
            file.write_all(&buffer[..count])
                .map_err(|e| invalid(e.to_string()))?;
        }
        len += count as u64;
    }
    if SourceStamp::read(&path, &source)? != stamp {
        return Err(invalid(format!(
            "Artifact changed while reading {name}; reload the complete build"
        )));
    }
    if format!("{:x}", hash.finalize()) != *expected {
        return Err(invalid(format!(
            "Artifact hash mismatch for {name}; build/reload the complete artifact"
        )));
    }
    Ok(match reusable {
        Some(asset) => Arc::new(Asset {
            path: asset.path.clone(),
            source: stamp,
            len,
        }),
        None => Arc::new(Asset {
            path: Arc::new(snapshot.expect("new snapshot").into_temp_path()),
            source: stamp,
            len,
        }),
    })
}
impl Artifact {
    pub fn read(directory: &Path) -> Result<Self, Error> {
        Self::read_reusing(directory, None)
    }
    fn read_reusing(directory: &Path, previous: Option<&Artifact>) -> Result<Self, Error> {
        let root = directory
            .canonicalize()
            .map_err(|e| invalid(e.to_string()))?;
        let manifest: Manifest = serde_json::from_reader(std::io::BufReader::new(
            File::open(root.join("manifest.json")).map_err(|e| invalid(e.to_string()))?,
        ))
        .map_err(|e| invalid(format!("Invalid plugin manifest: {e}")))?;
        if manifest.format_version != 1 {
            return Err(invalid("Unsupported plugin artifact version"));
        }
        DataSpace::plugin(&manifest.plugin.id).map_err(|e| invalid(e.to_string()))?;
        if manifest.plugin.id == "tokamak.host" {
            return Err(invalid("tokamak.host is reserved for kernel metadata"));
        }
        Version::parse(&manifest.plugin.version)
            .map_err(|e| invalid(format!("Invalid plugin version: {e}")))?;
        let requirement = manifest
            .plugin
            .api
            .strip_prefix("tokamak@")
            .ok_or_else(|| invalid("Host API requirement must start with tokamak@"))?;
        let requirement = VersionReq::parse(requirement)
            .map_err(|e| invalid(format!("Invalid host API range: {e}")))?;
        if !requirement
            .matches(&Version::parse(env!("CARGO_PKG_VERSION")).expect("package version"))
        {
            return Err(invalid(format!(
                "Incompatible host API for {}",
                manifest.plugin.id
            )));
        }
        if !["hub", "runner", "hybrid"].contains(&manifest.plugin.placement.as_str()) {
            return Err(invalid("Invalid plugin placement"));
        }
        for map in [
            &manifest.plugin.depends,
            &manifest.plugin.optional,
            &manifest.plugin.breaks,
        ] {
            for (id, range) in map {
                DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
                VersionReq::parse(range)
                    .map_err(|e| invalid(format!("Invalid dependency range: {e}")))?;
            }
        }
        for list in [
            &manifest.plugin.provides,
            &manifest.plugin.consumes,
            &manifest.plugin.permissions,
        ] {
            let unique = list.iter().collect::<BTreeSet<_>>();
            if unique.len() != list.len() || list.iter().any(|value| value.is_empty()) {
                return Err(invalid("Invalid plugin capability/interface list"));
            }
        }
        let mut names = BTreeSet::new();
        let backend_paths = manifest
            .entries
            .backend
            .as_ref()
            .into_iter()
            .flat_map(|entry| [&entry.code, &entry.map, &entry.api]);
        let ui_paths = manifest
            .entries
            .ui
            .as_ref()
            .into_iter()
            .flat_map(|entry| [&entry.code, &entry.map, &entry.css, &entry.shell]);
        for name in backend_paths.chain(ui_paths) {
            if !names.insert(name) {
                return Err(invalid(
                    "Artifact entry paths must be distinct; UI cannot alias backend files",
                ));
            }
        }
        let mut assets = BTreeMap::new();
        for name in names {
            let whole_backend = manifest
                .entries
                .backend
                .as_ref()
                .is_some_and(|entry| name == &entry.code || name == &entry.map);
            assets.insert(
                name.clone(),
                asset(&root, name, &manifest.hashes, previous, whole_backend)?,
            );
        }
        let bundle = manifest
            .entries
            .backend
            .as_ref()
            .map(|entry| {
                if let Some(previous) = previous {
                    if let Some(old) = &previous.manifest.entries.backend {
                        if old.code == entry.code
                            && old.map == entry.map
                            && manifest.hashes.get(&entry.code)
                                == previous.manifest.hashes.get(&old.code)
                            && manifest.hashes.get(&entry.map)
                                == previous.manifest.hashes.get(&old.map)
                        {
                            return Ok(previous.bundle.clone().expect("backend bundle"));
                        }
                    }
                }
                let source = assets[&entry.code].backend_text(&entry.code)?;
                let map = assets[&entry.map].backend_text(&entry.map)?;
                Bundle::new(source, Some(&map))
                    .map(Arc::new)
                    .map_err(|e| invalid(e.to_string()))
            })
            .transpose()?;
        let provides = manifest.plugin.provides.iter().cloned().collect();
        let consumes = manifest.plugin.consumes.iter().cloned().collect();
        let permissions = manifest.plugin.permissions.iter().cloned().collect();
        Ok(Self {
            manifest,
            bundle,
            assets,
            provides,
            consumes,
            permissions,
        })
    }
    /// Only explicitly declared UI files are downloadable. No arbitrary paths,
    /// server source, credentials or on-disk files can be fetched by this method.
    pub fn ui_asset(&self, name: &str) -> Option<Arc<Asset>> {
        let ui = self.manifest.entries.ui.as_ref()?;
        [&ui.code, &ui.map, &ui.css, &ui.shell]
            .iter()
            .any(|file| file.as_str() == name)
            .then(|| self.assets.get(name).cloned())
            .flatten()
    }
}

impl Catalog {
    pub fn read(root: &Path) -> Result<Self, Error> {
        Self::read_reusing(root, None)
    }
    pub(crate) fn read_reusing(root: &Path, previous: Option<&Self>) -> Result<Self, Error> {
        let directories = if root.join("manifest.json").is_file() {
            vec![root.to_owned()]
        } else if root.join("dist/manifest.json").is_file() {
            vec![root.join("dist")]
        } else {
            let mut result = Vec::new();
            for entry in std::fs::read_dir(root).map_err(|e| invalid(e.to_string()))? {
                let entry = entry.map_err(|e| invalid(e.to_string()))?;
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                let path = entry.path();
                if path.join("manifest.json").is_file() {
                    result.push(path);
                } else if path.join("dist/manifest.json").is_file() {
                    result.push(path.join("dist"));
                } else if path.join("package.json").is_file() {
                    return Err(invalid(format!(
                        "Plugin has not been built: {}",
                        path.display()
                    )));
                }
            }
            result.sort();
            result
        };
        let mut plugins = BTreeMap::new();
        for directory in directories {
            // Read identity first to find reusable verified snapshots. The full
            // read still verifies changed files, detecting incomplete builds.
            let identity: Manifest = serde_json::from_reader(std::io::BufReader::new(
                File::open(directory.join("manifest.json")).map_err(|e| invalid(e.to_string()))?,
            ))
            .map_err(|e| invalid(format!("Invalid plugin manifest: {e}")))?;
            let old = previous.and_then(|p| p.plugins.get(&identity.plugin.id));
            let artifact = Artifact::read_reusing(&directory, old.map(AsRef::as_ref))?;
            let id = artifact.manifest.plugin.id.clone();
            if plugins.insert(id.clone(), Arc::new(artifact)).is_some() {
                return Err(invalid(format!(
                    "Duplicate installed plugin identity: {id}"
                )));
            }
        }
        let order = resolve(&plugins)?;
        let mut hash = Sha256::new();
        for id in &order {
            hash.update(
                serde_json::to_vec(&plugins[id].manifest).map_err(|e| invalid(e.to_string()))?,
            );
        }
        let mut providers = BTreeMap::<String, Vec<String>>::new();
        for id in &order {
            for interface in &plugins[id].provides {
                providers
                    .entry(interface.clone())
                    .or_default()
                    .push(id.clone());
            }
        }
        Ok(Self {
            order,
            plugins,
            revision: format!("{:x}", hash.finalize()),
            providers,
        })
    }
    pub fn metadata(&self) -> Value {
        json!({"revision":self.revision,"plugins":self.order.iter().map(|id| &self.plugins[id].manifest).collect::<Vec<_>>()})
    }
    pub fn providers(&self, caller: &str, interface: &str) -> Result<Vec<String>, Error> {
        let artifact = self
            .plugins
            .get(caller)
            .ok_or_else(|| invalid("Unknown calling plugin"))?;
        if !artifact.consumes.contains(interface) {
            return Err(invalid("Plugin does not declare this consumed interface"));
        }
        Ok(self.providers.get(interface).cloned().unwrap_or_default())
    }
    pub fn can_call(&self, caller: &str, target: &str) -> bool {
        let Some(caller) = self.plugins.get(caller) else {
            return false;
        };
        let Some(target) = self.plugins.get(target) else {
            return false;
        };
        let definition = &caller.manifest.plugin;
        definition.id == target.manifest.plugin.id
            || definition.depends.contains_key(&target.manifest.plugin.id)
            || definition.optional.contains_key(&target.manifest.plugin.id)
            || caller
                .consumes
                .iter()
                .any(|interface| target.provides.contains(interface))
    }
    pub fn permits_network(&self, plugin: &str, host: &str) -> bool {
        self.plugins.get(plugin).is_some_and(|artifact| {
            // Exact canonical-host grants only (WEB_APIS.md): TKM-45 removed the
            // `net:*` wildcard; the set is TKM-44's precomputed manifest view.
            artifact.permissions.contains(&format!("net:{host}"))
        })
    }
}

fn resolve(plugins: &BTreeMap<String, Arc<Artifact>>) -> Result<Vec<String>, Error> {
    for (id, artifact) in plugins {
        let definition = &artifact.manifest.plugin;
        for (dependency, range) in definition.depends.iter().chain(&definition.optional) {
            let Some(installed) = plugins.get(dependency) else {
                if definition.depends.contains_key(dependency) {
                    return Err(invalid(format!(
                        "Missing dependency {dependency} required by {id}"
                    )));
                }
                continue;
            };
            if !VersionReq::parse(range)
                .map_err(|e| invalid(e.to_string()))?
                .matches(
                    &Version::parse(&installed.manifest.plugin.version)
                        .map_err(|e| invalid(e.to_string()))?,
                )
            {
                return Err(invalid(format!(
                    "Incompatible dependency {dependency} for {id}: requires {range}"
                )));
            }
        }
        for (conflict, range) in &definition.breaks {
            if let Some(installed) = plugins.get(conflict) {
                if VersionReq::parse(range)
                    .map_err(|e| invalid(e.to_string()))?
                    .matches(
                        &Version::parse(&installed.manifest.plugin.version)
                            .map_err(|e| invalid(e.to_string()))?,
                    )
                {
                    return Err(invalid(format!("Plugin conflict: {id} breaks {conflict}")));
                }
            }
        }
    }
    // Iterative DFS keeps long dependency chains on the heap, with each edge
    // visited once; plugin count must never turn into native stack depth.
    let mut order = Vec::new();
    let mut done = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    for id in plugins.keys() {
        let mut stack = vec![(id.as_str(), false)];
        while let Some((id, exit)) = stack.pop() {
            if exit {
                visiting.remove(id);
                done.insert(id);
                order.push(id.to_owned());
                continue;
            }
            if done.contains(id) {
                continue;
            }
            if !visiting.insert(id) {
                return Err(invalid(format!("Plugin dependency cycle at {id}")));
            }
            stack.push((id, true));
            let definition = &plugins[id].manifest.plugin;
            for dependency in definition
                .depends
                .keys()
                .chain(definition.optional.keys())
                .rev()
            {
                if plugins.contains_key(dependency) {
                    stack.push((dependency, false));
                }
            }
        }
    }
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch() -> Scratch {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "dist/tests/plugins-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Scratch(path)
    }
    fn write(root: &Path, directory: &str, definition: Value) -> PathBuf {
        let path = root.join(directory);
        std::fs::create_dir_all(&path).unwrap();
        let mut hashes = BTreeMap::new();
        for (name, bytes) in [
            ("ui.js", "export {};"),
            ("ui.js.map", "{}"),
            ("styles.css", "body {}"),
            ("shell.html", "<html></html>"),
        ] {
            std::fs::write(path.join(name), bytes).unwrap();
            hashes.insert(name, format!("{:x}", Sha256::digest(bytes)));
        }
        std::fs::write(path.join("manifest.json"), serde_json::to_vec(&json!({
            "formatVersion":1, "plugin":definition, "hashes":hashes,
            "entries":{"ui":{"code":"ui.js","map":"ui.js.map","css":"styles.css","shell":"shell.html"}}
        })).unwrap()).unwrap();
        path
    }
    fn error(root: &Path) -> String {
        Catalog::read(root)
            .err()
            .expect("invalid catalog")
            .to_string()
    }
    #[test]
    fn resolves_dependencies_optional_providers_and_private_assets() {
        let root = scratch();
        write(
            &root.0,
            "z-core",
            json!({"id":"core","version":"0.1.0","provides":["ai"]}),
        );
        write(
            &root.0,
            "a-notes",
            json!({"id":"notes","version":"1.0.0",
            "depends":{"core":"^0.1"}, "optional":{"missing":"*"}, "consumes":["ai"],
            "permissions":["net:example.com"]}),
        );
        let catalog = Catalog::read(&root.0).unwrap();
        assert_eq!(catalog.order, ["core", "notes"]);
        assert_eq!(catalog.providers("notes", "ai").unwrap(), ["core"]);
        assert!(catalog.providers("notes", "private").is_err());
        assert!(catalog.can_call("notes", "core"));
        assert!(!catalog.can_call("core", "notes"));
        assert!(catalog.permits_network("notes", "example.com"));
        assert!(!catalog.permits_network("notes", "other.com"));
        assert!(catalog.plugins["notes"].ui_asset("ui.js").is_some());
        assert!(catalog.plugins["notes"].ui_asset("manifest.json").is_none());
        assert!(catalog.plugins["notes"].ui_asset("../ui.js").is_none());
        assert_eq!(Catalog::read(&root.0).unwrap().revision, catalog.revision);
        // Installed generations are snapshots, not files read again on requests.
        std::fs::write(root.0.join("a-notes/ui.js"), "changed").unwrap();
        assert_eq!(
            catalog.plugins["notes"]
                .ui_asset("ui.js")
                .unwrap()
                .read(0, 8192)
                .unwrap(),
            b"export {};"
        );
        assert!(error(&root.0).contains("hash mismatch"));
    }
    #[test]
    fn rejects_missing_incompatible_conflicting_cyclic_and_duplicate_plugins() {
        for (a, b, expected) in [
            (
                json!({"id":"a","version":"1.0.0","depends":{"missing":"*"}}),
                json!({"id":"b","version":"1.0.0"}),
                "Missing dependency",
            ),
            (
                json!({"id":"a","version":"1.0.0","depends":{"b":"^2"}}),
                json!({"id":"b","version":"1.0.0"}),
                "Incompatible dependency",
            ),
            (
                json!({"id":"a","version":"1.0.0","optional":{"b":"^2"}}),
                json!({"id":"b","version":"1.0.0"}),
                "Incompatible dependency",
            ),
            (
                json!({"id":"a","version":"1.0.0","breaks":{"b":"^1"}}),
                json!({"id":"b","version":"1.0.0"}),
                "Plugin conflict",
            ),
            (
                json!({"id":"a","version":"1.0.0","depends":{"b":"*"}}),
                json!({"id":"b","version":"1.0.0","depends":{"a":"*"}}),
                "cycle",
            ),
            (
                json!({"id":"a","version":"1.0.0"}),
                json!({"id":"a","version":"2.0.0"}),
                "Duplicate",
            ),
            (
                json!({"id":"a","version":"1.0.0","api":"tokamak@^9"}),
                json!({"id":"b","version":"1.0.0"}),
                "Incompatible host API",
            ),
        ] {
            let root = scratch();
            write(&root.0, "first", a);
            write(&root.0, "second", b);
            assert!(error(&root.0).contains(expected), "{expected}");
        }
    }
    #[test]
    fn rejects_unbuilt_and_escaping_artifacts() {
        let root = scratch();
        let project = root.0.join("unbuilt");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("package.json"), "{}").unwrap();
        assert!(error(&root.0).contains("not been built"));
        let path = write(&root.0, "artifact", json!({"id":"a","version":"1.0.0"}));
        let manifest = path.join("manifest.json");
        let mut metadata: Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        metadata["entries"]["ui"]["code"] = "../outside.js".into();
        std::fs::write(&manifest, metadata.to_string()).unwrap();
        assert!(
            Artifact::read(&path)
                .err()
                .unwrap()
                .to_string()
                .contains("inside")
        );
    }
    #[cfg(unix)]
    #[test]
    fn rejects_asset_symlinks_outside_artifact() {
        let root = scratch();
        let path = write(&root.0, "artifact", json!({"id":"a","version":"1.0.0"}));
        let outside = root.0.join("outside.js");
        std::fs::write(&outside, "export {};").unwrap();
        std::fs::remove_file(path.join("ui.js")).unwrap();
        std::os::unix::fs::symlink(outside, path.join("ui.js")).unwrap();
        assert!(
            Artifact::read(&path)
                .err()
                .unwrap()
                .to_string()
                .contains("symlink")
        );
    }
}
