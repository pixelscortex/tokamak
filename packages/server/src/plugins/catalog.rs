use super::*;

impl Catalog {
    pub fn read(root: &Path) -> Result<Self, Error> {
        Self::read_reusing(root, None)
    }

    pub(crate) fn read_reusing(root: &Path, previous: Option<&Self>) -> Result<Self, Error> {
        Self::read_in_directory(
            root,
            previous,
            previous
                .map(|p| p.directory.as_path())
                .unwrap_or(root.parent().unwrap_or(root)),
        )
    }

    pub(crate) fn read_in_directory(
        root: &Path,
        previous: Option<&Self>,
        directory: &Path,
    ) -> Result<Self, Error> {
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

        for directory in directories {
            // Read identity first to find reusable verified snapshots. The full
            // read still verifies changed files, detecting incomplete builds.
            let identity = Manifest::read(&directory)?;

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

        let environment = root.parent().unwrap_or(root).join(".env.local");

        let mut catalog = Self {
            order,
            plugins,
            revision: String::new(),
            providers: BTreeMap::new(),
            environment,
            directory: directory.to_owned(),
        };
        catalog.update_metadata()?;
        Ok(catalog)
    }

    pub(super) fn update_metadata(&mut self) -> Result<(), Error> {
        let mut hash = Sha256::new();

        for id in &self.order {
            hash.update(
                serde_json::to_vec(&self.plugins[id].manifest)
                    .map_err(|e| invalid(e.to_string()))?,
            );
        }

        self.providers.clear();

        for id in &self.order {
            for interface in &self.plugins[id].provides {
                self.providers
                    .entry(interface.clone())
                    .or_default()
                    .push(id.clone());
            }
        }

        self.revision = format!("{:x}", hash.finalize());
        Ok(())
    }

    pub fn metadata(&self) -> Value {
        json!({"revision":self.revision,"plugins":self.order.iter().map(|id| {
            let manifest = &self.plugins[id].manifest;
            let mut value = serde_json::to_value(manifest).expect("manifest serialization");
            value["revision"] = json!(self.revision);
            value["uiUrl"] = manifest.entries.ui.as_ref().map(|ui| format!("/plugins/{id}/{}/assets/{}", self.revision, ui.code)).into();
            value["stylesheetUrl"] = manifest.entries.ui.as_ref().and_then(|ui| ui.css.as_ref()).map(|css| format!("/plugins/{id}/{}/assets/{css}", self.revision)).into();
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
