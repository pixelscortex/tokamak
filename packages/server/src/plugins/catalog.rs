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
            None,
        )
    }

    pub(crate) fn read_in_directory(
        root: &Path,
        previous: Option<&Self>,
        directory: &Path,
        index_path: Option<&Path>,
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

        // Keep index membership fixed for this server lifetime, even across a
        // reload through the server's existing plugin controls.
        let index = match previous {
            Some(catalog) => Arc::clone(&catalog.index),
            None => Arc::new(read_index(index_path)?),
        };
        let mut sources = BTreeMap::new();
        for directory in directories {
            let id = Manifest::read(&directory)?.plugin.id;
            if sources.insert(id.clone(), directory).is_some() {
                return Err(invalid(format!(
                    "Duplicate installed plugin identity: {id}"
                )));
            }
        }

        let indexed = select_indexed_sources(&index, &mut sources)?;

        let mut plugins = BTreeMap::new();
        for (id, directory) in sources {
            let old = previous.and_then(|p| p.plugins.get(&id));
            let artifact = Artifact::read_reusing(&directory, old.map(AsRef::as_ref))?;
            if artifact.manifest.plugin.id != id {
                return Err(invalid(format!(
                    "Plugin identity changed while reading {}",
                    directory.display()
                )));
            }
            plugins.insert(id, Arc::new(artifact));
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

        let environment = root.parent().unwrap_or(root).join(".env.local");

        Ok(Self {
            order,
            plugins,
            revision: format!("{:x}", hash.finalize()),
            providers,
            index,
            indexed,
            environment,
            directory: directory.to_owned(),
        })
    }

    pub fn metadata(&self) -> Value {
        json!({"revision":self.revision,"plugins":self.order.iter().map(|id| {
            let manifest = &self.plugins[id].manifest;
            let mut value = serde_json::to_value(manifest).expect("manifest serialization");
            value["fromIndex"] = json!(self.indexed.contains(id));
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

fn read_index(path: Option<&Path>) -> Result<BTreeMap<String, PathBuf>, Error> {
    let Some(path) = path else {
        return Ok(BTreeMap::new());
    };
    let source = match std::fs::read(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => {
            return Err(invalid(format!(
                "Cannot read plugin index {}: {error}",
                path.display()
            )));
        }
    };
    let entries: BTreeMap<String, PathBuf> = serde_json::from_slice(&source)
        .map_err(|error| invalid(format!("Invalid plugin index {}: {error}", path.display())))?;
    for (id, folder) in &entries {
        if !folder.is_absolute() {
            return Err(invalid(format!(
                "Indexed plugin {id} needs an absolute source folder"
            )));
        }
    }
    Ok(entries)
}

fn select_indexed_sources(
    index: &BTreeMap<String, PathBuf>,
    sources: &mut BTreeMap<String, PathBuf>,
) -> Result<BTreeSet<String>, Error> {
    let mut indexed = BTreeSet::new();
    for (id, folder) in index {
        let dist = folder.join("dist");
        if !dist.join("manifest.json").is_file() {
            eprintln!(
                "Skipping indexed plugin {id}: no build at {}",
                dist.display()
            );
            continue;
        }
        let actual = Manifest::read(&dist)?.plugin.id;
        if actual != *id {
            return Err(invalid(format!(
                "Indexed plugin {id} has plugin identity {actual} in {}",
                dist.display()
            )));
        }
        sources.insert(id.clone(), dist);
        indexed.insert(id.clone());
    }

    Ok(indexed)
}
