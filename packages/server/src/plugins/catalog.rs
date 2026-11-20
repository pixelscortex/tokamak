use super::*;

impl Catalog {
    pub fn read(root: &Path) -> Result<Self, Error> {
        let (plugins, _) = read_installed(root, None, |_| false)?;
        Self::assemble(root, root.parent().unwrap_or(root), plugins, Arc::default())
    }

    pub(crate) fn read_for_reload(
        root: &Path,
        previous: Option<&Loaded>,
    ) -> Result<(Self, BTreeMap<String, String>), Error> {
        let old = previous.map(|p| &p.catalog);
        let directory = old
            .map(|p| p.directory.as_path())
            .unwrap_or(root.parent().unwrap_or(root));
        let package_root = old.and_then(|catalog| catalog.package_root.as_deref());
        let (mut plugins, mut failures) = read_with_packages(root, previous, package_root)?;
        let index = old.map(|p| Arc::clone(&p.index)).unwrap_or_default();
        let mut installed = installed_paths(&plugins);
        if let Some(previous) = previous {
            for id in index.keys() {
                if let Some(artifact) = previous.catalog.plugins.get(id) {
                    plugins.insert(id.clone(), Arc::clone(artifact));
                    failures.remove(id);
                } else if let Some(reason) = previous.skipped.get(id) {
                    failures.insert(id.clone(), reason.clone());
                }
            }
            for id in failures.keys() {
                if let Some(source) = previous.catalog.installed.get(id) {
                    installed.insert(id.clone(), source.clone());
                }
            }
        }
        let mut catalog = Self::assemble_candidate(root, directory, plugins, index, &failures)?;
        catalog.installed = installed;
        catalog.index_path = old.and_then(|p| p.index_path.clone());
        catalog.package_root = old.and_then(|p| p.package_root.clone());
        Ok((catalog, failures))
    }

    pub(crate) fn read_indexed_reload(
        root: &Path,
        loaded: &Loaded,
        request: &IndexedReload,
    ) -> Result<(Self, BTreeMap<String, String>), Error> {
        let previous = &loaded.catalog;
        let path = previous
            .index_path
            .as_deref()
            .ok_or_else(|| invalid("Server has no local plugin index"))?;
        let entries = index_entries(path)?;
        if let Some(store) = &previous.package_root {
            check_index_sources(&entries, store)?;
        }
        let mut plugins = previous.plugins.clone();
        let mut index = (*previous.index).clone();
        if request.remove_missing {
            apply_removals(previous, &entries, &mut index, &mut plugins)?;
        }
        for IndexedBuild { id, build_id } in &request.builds {
            let folder = entries
                .get(id)
                .and_then(Value::as_str)
                .ok_or_else(|| invalid(format!("Plugin is not indexed: {id}")))?;
            let old = previous.plugins.get(id).map(AsRef::as_ref);
            plugins.insert(
                id.clone(),
                read_indexed_build(id, Path::new(folder), old, Some(build_id))?,
            );
            index.insert(id.clone(), PathBuf::from(folder));
        }
        let failures = retry_skipped(loaded, request, &index, &mut plugins);
        let mut catalog = Self::assemble_candidate(
            root,
            &previous.directory,
            plugins,
            Arc::new(index),
            &failures,
        )?;
        catalog.installed.clone_from(&previous.installed);
        catalog.index_path.clone_from(&previous.index_path);
        catalog.package_root.clone_from(&previous.package_root);
        Ok((catalog, failures))
    }

    pub(crate) fn with_package(
        root: &Path,
        previous: &Loaded,
        id: &str,
        artifact: Artifact,
    ) -> Result<(Self, BTreeMap<String, String>), Error> {
        let old = &previous.catalog;
        let mut plugins = old.plugins.clone();
        for dependency in artifact.manifest.plugin.depends.keys() {
            if !plugins.contains_key(dependency) {
                return Err(invalid(format!(
                    "Missing dependency {dependency} required by {id}"
                )));
            }
        }
        let source = artifact.source.clone();
        plugins.insert(id.to_owned(), Arc::new(artifact));
        let mut skipped = previous.skipped.clone();
        skipped.remove(id);
        let mut catalog = Self::assemble_candidate(
            root,
            &old.directory,
            plugins,
            Arc::clone(&old.index),
            &skipped,
        )?;
        catalog.installed.clone_from(&old.installed);
        catalog.installed.insert(id.to_owned(), source);
        catalog.index_path.clone_from(&old.index_path);
        catalog.package_root.clone_from(&old.package_root);
        Ok((catalog, skipped))
    }

    pub(crate) fn removable_package(
        &self,
        id: &str,
        skipped: &BTreeMap<String, String>,
    ) -> Result<&Path, Error> {
        if self.index.contains_key(id) {
            return Err(invalid(format!(
                "Plugin {id} is managed by the local plugin index; use tokamak plugin remove {id}"
            )));
        }
        let source = self.installed.get(id);
        if let Some(root) = self.package_root.as_deref() {
            let package = root.join(id);
            let stored = match source {
                Some(source) => *source == package.join("dist"),
                None => skipped.contains_key(id) && package::removal_path(root, id).is_ok(),
            };
            if stored {
                return Ok(root);
            }
        }
        if source.is_some() || skipped.contains_key(id) {
            return Err(invalid(format!(
                "Plugin {id} comes from the --plugins folder and cannot be removed here"
            )));
        }
        Err(invalid(format!("Plugin not found: {id}")))
    }

    pub(crate) fn without_package(
        root: &Path,
        previous: &Loaded,
        id: &str,
    ) -> Result<(Self, BTreeMap<String, String>), Error> {
        let old = &previous.catalog;
        if let Some((dependent, _)) = old.plugins.iter().find(|(_, artifact)| {
            artifact
                .manifest
                .plugin
                .dependencies()
                .any(|(dependency, _)| dependency == id)
        }) {
            return Err(invalid(format!(
                "Cannot remove {id}: plugin {dependent} depends on it"
            )));
        }

        let fallback = find_package_fallback(root, id).map_err(|error| {
            invalid(format!(
                "Cannot restore the --plugins copy of {id}: {error}"
            ))
        })?;
        let mut plugins = old.plugins.clone();
        let mut installed = old.installed.clone();
        plugins.remove(id);
        installed.remove(id);
        if let Some(artifact) = fallback {
            installed.insert(id.to_owned(), artifact.source.clone());
            plugins.insert(id.to_owned(), Arc::new(artifact));
        }
        let mut skipped = previous.skipped.clone();
        skipped.remove(id);

        let mut catalog = Self::assemble_candidate(
            root,
            &old.directory,
            plugins,
            Arc::clone(&old.index),
            &skipped,
        )?;
        catalog.installed = installed;
        catalog.index_path.clone_from(&old.index_path);
        catalog.package_root.clone_from(&old.package_root);
        Ok((catalog, skipped))
    }

    pub(super) fn assemble(
        root: &Path,
        directory: &Path,
        plugins: BTreeMap<String, Arc<Artifact>>,
        index: Arc<BTreeMap<String, PathBuf>>,
    ) -> Result<Self, Error> {
        Self::assemble_candidate(root, directory, plugins, index, &BTreeMap::new())
    }

    pub(super) fn assemble_candidate(
        root: &Path,
        directory: &Path,
        plugins: BTreeMap<String, Arc<Artifact>>,
        index: Arc<BTreeMap<String, PathBuf>>,
        failures: &BTreeMap<String, String>,
    ) -> Result<Self, Error> {
        let order = resolve(&plugins, |id| failures.contains_key(id))?;
        let mut catalog = Self {
            order,
            plugins,
            index,
            revision: String::new(),
            providers: BTreeMap::new(),
            installed: BTreeMap::new(),
            index_path: None,
            package_root: None,
            environment: root.parent().unwrap_or(root).join(".env.local"),
            directory: directory.to_owned(),
        };
        catalog.update_metadata();
        Ok(catalog)
    }

    pub(super) fn omit_skipped(&mut self, skipped: &BTreeMap<String, String>) -> Result<(), Error> {
        self.plugins.retain(|id, _| !skipped.contains_key(id));
        // Even a skipped plugin's dependencies can change DFS order. Rebuild
        // from the active graph so skipped manifests cannot affect the revision.
        self.order = resolve(&self.plugins, |_| false)?;
        self.update_metadata();
        Ok(())
    }

    fn update_metadata(&mut self) {
        let mut hash = Sha256::new();
        self.providers.clear();

        for id in &self.order {
            let artifact = &self.plugins[id];
            hash.update(artifact.build_id.as_bytes());
            hash.update([u8::from(self.index.contains_key(id))]);
            for interface in &artifact.provides {
                self.providers
                    .entry(interface.clone())
                    .or_default()
                    .push(id.clone());
            }
        }

        self.revision = format!("{:x}", hash.finalize());
    }

    pub(super) fn same_build(&self, previous: &Self, id: &str) -> bool {
        self.plugins.get(id).is_some_and(|artifact| {
            previous
                .plugins
                .get(id)
                .is_some_and(|old| old.build_id == artifact.build_id)
        })
    }

    pub(crate) fn installation_warnings(root: &Path) -> Vec<String> {
        match installed_directories(root) {
            Ok(directories) => directories
                .iter()
                .filter_map(|path| {
                    Manifest::read(path)
                        .err()
                        .map(|error| format!("{}: {error}", path.display()))
                })
                .collect(),
            Err(error) => vec![error.to_string()],
        }
    }

    pub fn metadata(&self) -> Value {
        json!({"revision":self.revision,"plugins":self.order.iter().map(|id| {
            let artifact = &self.plugins[id];
            let manifest = &artifact.manifest;
            let build_id = &artifact.build_id;
            let mut value = serde_json::to_value(manifest).expect("manifest serialization");
            value["fromIndex"] = json!(self.index.contains_key(id));
            value["revision"] = json!(build_id);
            value["uiUrl"] = manifest.entries.ui.as_ref().map(|ui| format!("/plugins/{id}/{build_id}/assets/{}", ui.code)).into();
            value["stylesheetUrl"] = manifest.entries.ui.as_ref().and_then(|ui| ui.css.as_ref()).map(|css| format!("/plugins/{id}/{build_id}/assets/{css}")).into();
            value
        }).collect::<Vec<_>>()})
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

fn artifact_directory(root: &Path) -> Option<PathBuf> {
    if root.join("manifest.json").is_file() {
        Some(root.to_owned())
    } else if root.join("dist/manifest.json").is_file() {
        Some(root.join("dist"))
    } else {
        None
    }
}

pub(super) type IndexedArtifacts = BTreeMap<String, (PathBuf, Arc<Artifact>)>;

pub(super) fn read_index(path: Option<&Path>) -> IndexedArtifacts {
    let Some(path) = path else {
        return BTreeMap::new();
    };
    let entries = match index_entries(path) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("Warning: ignoring plugin index {}: {error}", path.display());
            return BTreeMap::new();
        }
    };
    entries
        .into_iter()
        .filter_map(|(id, value)| {
            let folder = Path::new(value.as_str().unwrap_or_default());
            let result = if value.is_string() {
                read_indexed(&id, folder, None)
            } else {
                Err(invalid("Expected an absolute source folder string"))
            };
            match result {
                Ok(artifact) => Some((id, (folder.to_owned(), artifact))),
                Err(error) => {
                    let source = value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string());
                    eprintln!("Skipping indexed plugin {id} at {source}: {error}");
                    None
                }
            }
        })
        .collect()
}

pub(super) fn check_index_overlap(index: Option<&Path>, store: &Path) -> Result<(), Error> {
    // The existing loader reports malformed indexes and falls back to installed plugins.
    if let Some(entries) = index.and_then(|path| index_entries(path).ok()) {
        check_index_sources(&entries, store)?;
    }
    Ok(())
}

fn check_index_sources(entries: &BTreeMap<String, Value>, store: &Path) -> Result<(), Error> {
    for folder in entries.values().filter_map(Value::as_str).map(Path::new) {
        if folder.is_absolute() {
            package::check_overlap(store, folder)?;
        }
    }
    Ok(())
}

fn index_entries(path: &Path) -> Result<BTreeMap<String, Value>, Error> {
    let source = match std::fs::read(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(invalid(error.to_string())),
    };
    serde_json::from_slice(&source).map_err(|error| invalid(error.to_string()))
}

fn read_indexed(id: &str, folder: &Path, old: Option<&Artifact>) -> Result<Arc<Artifact>, Error> {
    read_indexed_build(id, folder, old, None)
}

fn read_indexed_build(
    id: &str,
    folder: &Path,
    old: Option<&Artifact>,
    expected: Option<&str>,
) -> Result<Arc<Artifact>, Error> {
    if !folder.is_absolute() {
        return Err(invalid("Expected an absolute source folder"));
    }
    let dist = folder.join("dist");
    let manifest = Manifest::read(&dist)?;
    if expected.is_some_and(|build_id| build_id != manifest.1) {
        return Err(invalid(format!(
            "{id}: the build changed after this reload started; run the command again"
        )));
    }
    let artifact = Artifact::read_reusing(&dist, manifest, old)?;
    if artifact.manifest.plugin.id != id {
        return Err(invalid(format!(
            "Build has plugin identity {}",
            artifact.manifest.plugin.id
        )));
    }
    Ok(Arc::new(artifact))
}

type Artifacts = BTreeMap<String, Arc<Artifact>>;
type ArtifactFailures = BTreeMap<String, String>;

fn installed_directories(root: &Path) -> Result<Vec<PathBuf>, Error> {
    Ok(if let Some(directory) = artifact_directory(root) {
        vec![directory]
    } else {
        let mut result = Vec::new();

        for entry in std::fs::read_dir(root).map_err(|e| invalid(e.to_string()))? {
            let entry = entry.map_err(|e| invalid(e.to_string()))?;

            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }

            let path = entry.path();

            if let Some(directory) = artifact_directory(&path) {
                result.push(directory);
            } else if path.join("package.json").is_file() {
                return Err(invalid(format!(
                    "Plugin has not been built: {}",
                    path.display()
                )));
            }
        }
        result.sort();
        result
    })
}

fn find_package_fallback(root: &Path, id: &str) -> Result<Option<Artifact>, Error> {
    // Match startup's source selection, but load only the build being restored.
    let mut fallback = None;
    for directory in installed_directories(root)? {
        let build = Manifest::read(&directory)?;
        if build.0.plugin.id == id {
            if fallback.is_some() {
                return Err(invalid(format!(
                    "Duplicate installed plugin identity: {id}"
                )));
            }
            fallback = Some(Artifact::read_reusing(&directory, build, None)?);
        }
    }
    Ok(fallback)
}

fn read_installed(
    root: &Path,
    previous: Option<&Loaded>,
    is_shadowed: impl Fn(&str) -> bool,
) -> Result<(Artifacts, ArtifactFailures), Error> {
    let directories = installed_directories(root)?;
    let mut plugins = BTreeMap::new();
    let mut skipped = BTreeMap::new();

    for directory in directories {
        let build = Manifest::read(&directory)?;
        let id = build.0.plugin.id.clone();
        if is_shadowed(&id) {
            continue;
        }
        if plugins.contains_key(&id) || skipped.contains_key(&id) {
            return Err(invalid(format!(
                "Duplicate installed plugin identity: {id}"
            )));
        }
        let old = previous.and_then(|p| p.catalog.plugins.get(&id));
        // Even when the manifest is unchanged, verify files whose source
        // stamp changed so a partial build cannot pass as a no-op.
        match Artifact::read_reusing(&directory, build, old.map(AsRef::as_ref)) {
            Ok(artifact) => {
                plugins.insert(id, Arc::new(artifact));
            }
            Err(error) if previous.is_some_and(|p| p.skipped.contains_key(&id)) => {
                skipped.insert(id, error.to_string());
            }
            Err(error) => return Err(error),
        }
    }

    Ok((plugins, skipped))
}

pub(super) fn read_with_packages(
    root: &Path,
    previous: Option<&Loaded>,
    package_root: Option<&Path>,
) -> Result<(Artifacts, ArtifactFailures), Error> {
    let (stored, skipped) = match package_root {
        Some(directory) => package::read_stored(directory, previous)?,
        None => (BTreeMap::new(), BTreeMap::new()),
    };
    let (mut plugins, mut failures) = read_installed(root, previous, |id| {
        stored.contains_key(id) || skipped.contains_key(id)
    })?;
    plugins.extend(stored);
    failures.extend(skipped);
    Ok((plugins, failures))
}

pub(super) fn installed_paths(
    plugins: &BTreeMap<String, Arc<Artifact>>,
) -> BTreeMap<String, PathBuf> {
    plugins
        .iter()
        .map(|(id, artifact)| (id.clone(), artifact.source.clone()))
        .collect()
}

fn retry_skipped(
    loaded: &Loaded,
    request: &IndexedReload,
    index: &BTreeMap<String, PathBuf>,
    plugins: &mut Artifacts,
) -> ArtifactFailures {
    let mut failures = BTreeMap::new();
    for (id, reason) in &loaded.skipped {
        if request.builds.iter().any(|build| build.id == *id) || plugins.contains_key(id) {
            continue;
        }
        let artifact = if let Some(folder) = index.get(id) {
            read_indexed(id, folder, None)
        } else if let Some(source) = loaded.catalog.installed.get(id) {
            Artifact::read(source).map(Arc::new)
        } else {
            if !loaded.catalog.index.contains_key(id) {
                failures.insert(id.clone(), reason.clone());
            }
            continue;
        };
        match artifact {
            Ok(artifact) if artifact.manifest.plugin.id == *id => {
                plugins.insert(id.clone(), artifact);
            }
            Ok(_) => {
                failures.insert(id.clone(), "Plugin identity changed".into());
            }
            Err(error) => {
                failures.insert(id.clone(), error.to_string());
            }
        }
    }
    failures
}

fn apply_removals(
    previous: &Catalog,
    entries: &BTreeMap<String, Value>,
    index: &mut BTreeMap<String, PathBuf>,
    plugins: &mut Artifacts,
) -> Result<(), Error> {
    for id in previous
        .index
        .keys()
        .filter(|id| !entries.contains_key(*id))
    {
        index.remove(id);
        plugins.remove(id);
        if let Some(source) = previous.installed.get(id) {
            let fallback = Artifact::read(source)?;
            if fallback.manifest.plugin.id != *id {
                return Err(invalid(format!("Installed copy of {id} changed identity")));
            }
            plugins.insert(id.clone(), Arc::new(fallback));
        }
    }
    Ok(())
}
