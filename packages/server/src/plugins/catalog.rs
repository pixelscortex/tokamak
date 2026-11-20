use super::*;

impl Catalog {
    pub fn read(root: &Path) -> Result<Self, Error> {
        Self::read_in_directory(root, root.parent().unwrap_or(root))
    }

    pub(crate) fn read_for_reload(
        root: &Path,
        previous: Option<&Loaded>,
    ) -> Result<(Self, BTreeMap<String, String>), Error> {
        Self::read_installation(
            root,
            previous,
            previous
                .map(|p| p.catalog.directory.as_path())
                .unwrap_or(root.parent().unwrap_or(root)),
        )
    }

    pub(crate) fn read_in_directory(root: &Path, directory: &Path) -> Result<Self, Error> {
        Self::read_installation(root, None, directory).map(|(catalog, _)| catalog)
    }

    fn read_installation(
        root: &Path,
        previous: Option<&Loaded>,
        directory: &Path,
    ) -> Result<(Self, BTreeMap<String, String>), Error> {
        let directories = if let Some(directory) = artifact_directory(root) {
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
        };

        let mut plugins = BTreeMap::new();
        let mut skipped = BTreeMap::new();

        for directory in directories {
            let build = Manifest::read(&directory)?;
            let id = build.0.plugin.id.clone();
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

        let order = resolve(&plugins, |id| skipped.contains_key(id))?;

        let environment = root.parent().unwrap_or(root).join(".env.local");
        let mut catalog = Self {
            order,
            plugins,
            revision: String::new(),
            providers: BTreeMap::new(),
            environment,
            directory: directory.to_owned(),
        };
        catalog.update_metadata();
        Ok((catalog, skipped))
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

    pub fn metadata(&self) -> Value {
        json!({"revision":self.revision,"plugins":self.order.iter().map(|id| {
            let artifact = &self.plugins[id];
            let manifest = &artifact.manifest;
            let build_id = &artifact.build_id;
            let mut value = serde_json::to_value(manifest).expect("manifest serialization");
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
