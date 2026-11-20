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
            previous.and_then(|p| p.index_path.as_deref()),
        )
    }

    pub(crate) fn read_in_directory(
        root: &Path,
        previous: Option<&Self>,
        directory: &Path,
        index_path: Option<&Path>,
    ) -> Result<Self, Error> {
        Self::read_selection(root, previous, directory, index_path, None)
    }

    pub(crate) fn read_indexed_reload(
        root: &Path,
        previous: &Self,
        ids: &[String],
        remove_missing: bool,
    ) -> Result<Self, Error> {
        if previous.index_path.is_none() {
            return Err(invalid("Server has no local plugin index"));
        }
        Self::read_selection(
            root,
            Some(previous),
            &previous.directory,
            previous.index_path.as_deref(),
            Some((ids, remove_missing)),
        )
    }

    fn read_selection(
        root: &Path,
        previous: Option<&Self>,
        directory: &Path,
        index_path: Option<&Path>,
        selection: Option<(&[String], bool)>,
    ) -> Result<Self, Error> {
        let index = read_index(index_path)?;
        let removed: BTreeSet<_> = previous
            .into_iter()
            .filter(|_| selection.is_some_and(|(_, remove)| remove))
            .flat_map(|old| &old.indexed)
            .filter(|id| !index.contains_key(*id))
            .collect();
        let mut sources = installed_sources(root, selection.map(|_| &removed))?;
        let mut plugins = BTreeMap::new();
        let indexed = if let Some((ids, _)) = selection {
            let mut indexed = BTreeSet::new();
            let selected: BTreeSet<_> = ids.iter().collect();
            if let Some(old) = previous {
                // A plugin that did not build keeps its verified artifact even
                // if its source folder or on-disk build no longer exists.
                let untouched = old
                    .plugins
                    .iter()
                    .filter(|(id, _)| !selected.contains(id) && !removed.contains(id));
                for (id, artifact) in untouched {
                    plugins.insert(id.clone(), Arc::clone(artifact));
                }
                indexed.extend(
                    old.indexed
                        .iter()
                        .filter(|id| plugins.contains_key(*id))
                        .cloned(),
                );
            }
            for id in ids {
                let folder = index
                    .get(id)
                    .ok_or_else(|| invalid(format!("Plugin is not indexed: {id}")))?;
                sources.insert(id.clone(), folder.join("dist"));
                indexed.insert(id.clone());
            }
            indexed
        } else {
            select_indexed_sources(&index, &mut sources)?
        };

        for (id, directory) in sources {
            let old = previous.and_then(|p| p.plugins.get(&id));
            let artifact = Artifact::read_reusing(
                &directory,
                Manifest::read(&directory)?,
                old.map(AsRef::as_ref),
            )?;
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
            hash.update(plugins[id].build_id.as_bytes());
            hash.update([u8::from(indexed.contains(id))]);
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
            index_path: index_path.map(Path::to_owned),
            indexed,
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
            value["fromIndex"] = json!(self.indexed.contains(id));
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

fn installed_sources(
    root: &Path,
    only: Option<&BTreeSet<&String>>,
) -> Result<BTreeMap<String, PathBuf>, Error> {
    if only.is_some_and(BTreeSet::is_empty) {
        return Ok(BTreeMap::new());
    }
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
            } else if only.is_none() && path.join("package.json").is_file() {
                return Err(invalid(format!(
                    "Plugin has not been built: {}",
                    path.display()
                )));
            }
        }
        result.sort();
        result
    };

    let mut sources = BTreeMap::new();
    for directory in directories {
        let id = Manifest::read(&directory)?.0.plugin.id;
        if only.is_some_and(|ids| !ids.contains(&id)) {
            continue;
        }
        if sources.insert(id.clone(), directory).is_some() {
            return Err(invalid(format!(
                "Duplicate installed plugin identity: {id}"
            )));
        }
    }

    Ok(sources)
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
        let actual = Manifest::read(&dist)?.0.plugin.id;
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
