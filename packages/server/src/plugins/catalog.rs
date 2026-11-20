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
            let build = Manifest::read(&directory)?;
            let old = previous.and_then(|p| p.plugins.get(&build.0.plugin.id));
            // Even when the manifest is unchanged, verify files whose source
            // stamp changed so a partial build cannot pass as a no-op.
            let artifact = Artifact::read_reusing(&directory, build, old.map(AsRef::as_ref))?;

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
            hash.update(plugins[id].build_id.as_bytes());
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

        let environment = root.parent().unwrap_or(root).join(".env.local");

        Ok(Self {
            order,
            plugins,
            revision: format!("{:x}", hash.finalize()),
            providers,
            environment,
            directory: directory.to_owned(),
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
