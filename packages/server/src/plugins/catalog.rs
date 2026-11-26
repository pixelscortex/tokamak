use super::*;

const INSTALL_ORDER_FILE: &str = "plugin-install-order.json";

pub(super) struct ScanSkip {
    reason: String,
    folder: PathBuf,
}

impl Catalog {
    pub fn read(root: &Path) -> Result<Self, Error> {
        Self::read_in_directory(root, None, root.parent().unwrap_or(root), &[])
    }

    pub(crate) fn read_for_reload(
        root: &Path,
        previous: &Self,
        reloaded: &str,
    ) -> Result<Self, Error> {
        Self::read_in_directory(
            root,
            Some((previous, reloaded)),
            &previous.directory,
            &previous.install_order,
        )
    }

    pub(crate) fn read_at_startup(root: &Path, directory: Option<&Path>) -> Result<Self, Error> {
        let install_order = read_install_order(directory)?;
        Self::read_in_directory(
            root,
            None,
            directory.unwrap_or(root.parent().unwrap_or(root)),
            &install_order,
        )
    }

    fn read_in_directory(
        root: &Path,
        reload: Option<(&Self, &str)>,
        directory: &Path,
        install_order: &[String],
    ) -> Result<Self, Error> {
        let plugins_folder = std::path::absolute(root).map_err(|e| invalid(e.to_string()))?;
        let FolderScan {
            mut plugins,
            mut folders,
            skips,
            duplicates,
            retained,
        } = FolderScan::read(&plugins_folder, reload)?;

        let unreadable = skips.iter().map(|(key, _)| key.clone()).collect();
        let (order, failures) = resolve(&plugins, &unreadable);
        let mut occupied: BTreeSet<_> = plugins.keys().cloned().collect();
        let mut skipped = BTreeMap::new();
        for (id, failure) in failures {
            if retained.contains(&id)
                || reload
                    .is_some_and(|(old, target)| id == target && old.plugins.contains_key(target))
            {
                return Err(failure.reload_error(&id));
            }
            plugins.remove(&id);
            let folder = folders.remove(&id).expect("scanned plugin has a folder");
            skipped.insert(
                id,
                ScanSkip {
                    reason: failure.reason(),
                    folder,
                },
            );
        }
        for (key, skip) in skips {
            let key = available_key(key, "skipped", &mut occupied);
            skipped.insert(key, skip);
        }
        for (key, skip) in duplicates {
            let key = available_key(key, "duplicate", &mut occupied);
            skipped.insert(key, skip);
        }

        let (mut recorded, removed_plugins): (Vec<_>, Vec<_>) = install_order
            .iter()
            .cloned()
            .partition(|id| plugins.contains_key(id));
        let known: BTreeSet<_> = recorded.iter().map(String::as_str).collect();
        let added: Vec<_> = order
            .iter()
            .filter(|id| !known.contains(id.as_str()))
            .cloned()
            .collect();
        recorded.extend(added);

        let mut catalog = Self {
            order,
            install_order: recorded,
            removed_plugins,
            plugins,
            folders,
            skipped,
            plugins_folder,
            revision: String::new(),
            root: root.to_owned(),
            directory: directory.to_owned(),
        };
        catalog.update_metadata()?;
        Ok(catalog)
    }

    pub(crate) fn scan_skip_reason(&self, id: &str) -> Option<&str> {
        self.skipped.get(id).map(|skip| skip.reason.as_str())
    }

    pub(crate) fn persist_install_order(&self, directory: Option<&Path>) -> Result<(), Error> {
        let Some(directory) = directory else {
            return Ok(());
        };
        if read_install_order(Some(directory))? == self.install_order {
            return Ok(());
        }
        let failure = |error: &dyn std::fmt::Display| {
            invalid(format!("Save plugin installation order: {error}"))
        };
        let file = tempfile::NamedTempFile::new_in(directory).map_err(|error| failure(&error))?;
        serde_json::to_writer(&file, &self.install_order).map_err(|error| failure(&error))?;
        file.as_file().sync_all().map_err(|error| failure(&error))?;
        file.persist(directory.join(INSTALL_ORDER_FILE))
            .map_err(|error| failure(&error))?;
        Ok(())
    }

    pub(super) fn update_metadata(&mut self) -> Result<(), Error> {
        let mut hash = Sha256::new();

        for id in &self.order {
            hash.update(
                serde_json::to_vec(&self.plugins[id].manifest)
                    .map_err(|e| invalid(e.to_string()))?,
            );
        }

        for id in &self.install_order {
            if self.plugins.contains_key(id) {
                hash.update(id);
                hash.update([0]);
            }
        }

        hash.update(self.plugins_folder.as_os_str().as_encoded_bytes());
        for (id, folder) in &self.folders {
            hash.update(id);
            hash.update([0]);
            hash.update(folder.as_os_str().as_encoded_bytes());
            hash.update([0]);
        }
        for (id, skip) in &self.skipped {
            hash.update(id);
            hash.update([0]);
            hash.update(skip.folder.as_os_str().as_encoded_bytes());
            hash.update([0]);
            hash.update(&skip.reason);
            hash.update([0]);
        }
        self.revision = format!("{:x}", hash.finalize());
        Ok(())
    }

    pub(crate) fn runner_contract_providers(
        &self,
        owner: &str,
        declaration: &ContractDeclaration,
    ) -> Vec<Value> {
        self.order
            .iter()
            .flat_map(|plugin| {
                runner_provider_routes(&self.plugins[plugin].manifest, owner, declaration)
            })
            .collect()
    }

    pub fn metadata(&self) -> Value {
        let install_indexes = self
            .install_order
            .iter()
            .enumerate()
            .map(|(index, id)| (id, index))
            .collect::<BTreeMap<_, _>>();
        let skipped = self
            .skipped
            .iter()
            .map(|(id, skip)| (id, &skip.reason))
            .collect::<BTreeMap<_, _>>();
        let skipped_folders = self
            .skipped
            .iter()
            .map(|(id, skip)| (id, skip.folder.to_string_lossy()))
            .collect::<BTreeMap<_, _>>();
        json!({"revision":self.revision,"pluginsFolder":self.plugins_folder.to_string_lossy(),
            "skipped":skipped,"skippedFolders":skipped_folders,"plugins":self.order.iter().map(|id| {
            let manifest = &self.plugins[id].manifest;
            let mut value = serde_json::to_value(manifest).expect("manifest serialization");
            if let Some(object) = value.as_object_mut() {
                object.remove("pluginFunctions");
                object.remove("contractProviders");
            }
            let routes = manifest.contracts.iter().filter(|key| key.on == ContractTarget::Caller)
                .map(|key| (key.name.clone(), json!(self.runner_contract_providers(id, key))))
                .collect::<serde_json::Map<_, _>>();
            if !routes.is_empty() {
                value["runnerContractRoutes"] = Value::Object(routes);
            }
            value["folder"] = json!(self.folders[id].to_string_lossy());
            value["revision"] = json!(self.revision);
            value["installOrder"] = json!(install_indexes[id]);
            value["uiUrl"] = manifest.entries.ui.as_ref().map(|ui| format!("/plugins/{id}/{}/assets/{}", self.revision, ui.code)).into();
            value["stylesheetUrl"] = manifest.entries.ui.as_ref().and_then(|ui| ui.css.as_ref()).map(|css| format!("/plugins/{id}/{}/assets/{css}", self.revision)).into();
            value
        }).collect::<Vec<_>>()})
    }

    pub fn can_call(&self, caller: &str, target: &str) -> bool {
        let Some(caller) = self.plugins.get(caller) else {
            return false;
        };

        let Some(target) = self.plugins.get(target) else {
            return false;
        };

        let definition = &caller.manifest.plugin;
        definition.declares_access_to(&target.manifest.plugin.id)
    }

    pub fn permits_network(&self, plugin: &str, host: &str) -> bool {
        self.plugins.get(plugin).is_some_and(|artifact| {
            // Exact canonical-host grants only (WEB_APIS.md): TKM-45 removed the
            // `net:*` wildcard; the set is TKM-44's precomputed manifest view.
            artifact.permissions.contains(&format!("net:{host}"))
        })
    }
}

#[derive(Default)]
struct FolderScan {
    plugins: BTreeMap<String, Arc<Artifact>>,
    folders: BTreeMap<String, PathBuf>,
    skips: Vec<(String, ScanSkip)>,
    duplicates: Vec<(String, ScanSkip)>,
    retained: BTreeSet<String>,
}

impl FolderScan {
    fn read(root: &Path, reload: Option<(&Catalog, &str)>) -> Result<Self, Error> {
        use std::collections::btree_map::Entry;

        let previous = reload.map(|(old, _)| old);
        let old_folders: BTreeMap<_, _> = previous
            .into_iter()
            .flat_map(|old| old.plugins.keys().map(|id| (old.folders[id].as_path(), id)))
            .collect();
        let mut scan = Self::default();
        let mut duplicates = Vec::new();

        for folder in plugin_folders(root, old_folders.contains_key(root))? {
            let old_id = old_folders.get(folder.as_path()).copied();
            let artifact_dir = artifact_directory(&folder);
            if artifact_dir.is_none() && old_id.is_none() && !folder.join("package.json").is_file()
            {
                continue;
            }
            let (id, artifact, keep_previous) = match read_artifact(artifact_dir, &folder, previous)
            {
                Ok(artifact) => (artifact.manifest.plugin.id.clone(), artifact, false),
                Err((identity, error)) => {
                    let previous_build = previous
                        .and_then(|old| find_previous_artifact(old, old_id, identity.as_ref()));
                    let Some((id, artifact)) = previous_build else {
                        let key = identity.unwrap_or_else(|| folder_name(&folder));
                        scan.skips.push((
                            key,
                            ScanSkip {
                                reason: error.to_string(),
                                folder,
                            },
                        ));
                        continue;
                    };
                    if reload.is_some_and(|(_, target)| id == target) {
                        return Err(error);
                    }
                    (id.clone(), Arc::clone(artifact), true)
                }
            };

            // Preserve the last good snapshot even if a new duplicate sorts
            // before the active folder.
            let keep_previous = keep_previous && scan.retained.insert(id.clone());
            match scan.folders.entry(id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(folder);
                    scan.plugins.insert(id, artifact);
                }
                Entry::Occupied(mut entry) if keep_previous => {
                    duplicates.push((id.clone(), entry.insert(folder)));
                    scan.plugins.insert(id, artifact);
                }
                Entry::Occupied(_) => duplicates.push((id, folder)),
            }
        }

        for (id, folder) in duplicates {
            let first = &scan.folders[&id];
            let reason = format!(
                "duplicate of plugin {id}, already loaded from {}",
                first.display()
            );
            scan.duplicates
                .push((folder_name(&folder), ScanSkip { reason, folder }));
        }
        Ok(scan)
    }
}

fn read_artifact(
    directory: Option<PathBuf>,
    folder: &Path,
    previous: Option<&Catalog>,
) -> Result<Arc<Artifact>, (Option<String>, Error)> {
    let Some(dir) = directory else {
        return Err((
            None,
            invalid(format!("Plugin is not built: {}", folder.display())),
        ));
    };
    let manifest = Manifest::read(&dir).map_err(|error| (read_identity(&dir), error))?;
    let id = manifest.plugin.id.clone();
    let old = previous.and_then(|old| old.plugins.get(&id));
    Artifact::read_reusing(&dir, manifest, old.map(AsRef::as_ref))
        .map(Arc::new)
        .map_err(|error| (Some(id), error))
}

fn find_previous_artifact<'a>(
    previous: &'a Catalog,
    old_id: Option<&String>,
    identity: Option<&String>,
) -> Option<(&'a String, &'a Arc<Artifact>)> {
    // An unreadable copy with a known ID only stands for a moved plugin if
    // its previously active folder is gone.
    let id = old_id.or_else(|| {
        identity.filter(|id| previous.folders.get(*id).is_some_and(|path| !path.exists()))
    })?;
    previous.plugins.get_key_value(id)
}

fn plugin_folders(root: &Path, was_single_build: bool) -> Result<Vec<PathBuf>, Error> {
    let entries = std::fs::read_dir(root).map_err(|e| invalid(e.to_string()))?;
    if artifact_directory(root).is_some() || was_single_build {
        return Ok(vec![root.to_owned()]);
    }

    let mut children = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| invalid(e.to_string()))?;
        if !entry.file_name().to_string_lossy().starts_with('.') {
            children.push(entry.path());
        }
    }
    children.sort();
    Ok(children)
}

fn read_install_order(directory: Option<&Path>) -> Result<Vec<String>, Error> {
    let Some(directory) = directory else {
        return Ok(Vec::new());
    };
    let file = match File::open(directory.join(INSTALL_ORDER_FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(invalid(format!("Read plugin installation order: {error}"))),
    };
    serde_json::from_reader(std::io::BufReader::new(file))
        .map_err(|error| invalid(format!("Read plugin installation order: {error}")))
}

fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .unwrap_or(folder.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn available_key(key: String, suffix: &str, occupied: &mut BTreeSet<String>) -> String {
    let mut candidate = key.clone();
    while !occupied.insert(candidate.clone()) {
        candidate.push_str(&format!(" ({suffix})"));
    }
    candidate
}

fn read_identity(directory: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct Identity {
        id: String,
    }
    #[derive(Deserialize)]
    struct Header {
        plugin: Identity,
    }
    let header: Header = serde_json::from_reader(Manifest::open(directory).ok()?).ok()?;
    Some(header.plugin.id)
}

fn artifact_directory(root: &Path) -> Option<PathBuf> {
    let has_manifest = |path: &Path| match path.join("manifest.json").symlink_metadata() {
        Ok(_) => true,
        Err(error) => {
            error.kind() != std::io::ErrorKind::NotFound
                && error.kind() != std::io::ErrorKind::NotADirectory
        }
    };
    if has_manifest(root) {
        Some(root.to_owned())
    } else {
        let dist = root.join("dist");
        has_manifest(&dist).then_some(dist)
    }
}

pub(crate) fn runner_provider_routes(
    manifest: &Manifest,
    owner: &str,
    declaration: &ContractDeclaration,
) -> Vec<Value> {
    let plugin = &manifest.plugin.id;
    if !manifest.plugin.declares_access_to(owner) {
        return Vec::new();
    }
    let registrations: Vec<_> = manifest
        .contract_providers
        .iter()
        .filter(|entry| {
            entry.owner == owner
                && entry.name == declaration.name
                && entry.on == ContractTarget::Caller
        })
        .collect();
    if registrations
        .iter()
        .any(|entry| entry.declaration_hash != declaration.declaration_hash)
    {
        return vec![json!({"plugin":plugin, "incompatible":true})];
    }
    let Some((entry_hash, code_hash)) = crate::actions::runner_hashes(manifest) else {
        return Vec::new();
    };
    registrations
        .into_iter()
        .map(|registration| {
            let mut route = json!({
                "plugin":plugin,
                "owner":owner,
                "own":plugin == owner,
                "registration":registration.registration,
                "build":format!("{entry_hash}:{code_hash}"),
            });
            if let Some(reason) = &registration.unavailable {
                route["unavailable"] = json!(reason);
            }
            route
        })
        .collect()
}
