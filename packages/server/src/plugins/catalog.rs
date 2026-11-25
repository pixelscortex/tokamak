use super::*;

const INSTALL_ORDER_FILE: &str = "plugin-install-order.json";

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
            previous.map_or(&[], |p| p.install_order.as_slice()),
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
        previous: Option<&Self>,
        directory: &Path,
        install_order: &[String],
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

        for artifact_dir in directories {
            // Read identity first to find reusable verified snapshots. The full
            // read still verifies changed files, detecting incomplete builds.
            let identity = Manifest::read(&artifact_dir)?;

            let old = previous.and_then(|p| p.plugins.get(&identity.plugin.id));

            let artifact = Artifact::read_reusing(&artifact_dir, old.map(AsRef::as_ref))?;

            let id = artifact.manifest.plugin.id.clone();

            if plugins.insert(id.clone(), Arc::new(artifact)).is_some() {
                return Err(invalid(format!(
                    "Duplicate installed plugin identity: {id}"
                )));
            }
        }

        let order = resolve(&plugins)?;
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
            revision: String::new(),
            root: root.to_owned(),
            directory: directory.to_owned(),
        };
        catalog.update_metadata()?;
        Ok(catalog)
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

        self.revision = format!("{:x}", hash.finalize());
        Ok(())
    }

    pub fn metadata(&self) -> Value {
        let install_indexes = self
            .install_order
            .iter()
            .enumerate()
            .map(|(index, id)| (id, index))
            .collect::<BTreeMap<_, _>>();
        json!({"revision":self.revision,"plugins":self.order.iter().map(|id| {
            let manifest = &self.plugins[id].manifest;
            let mut value = serde_json::to_value(manifest).expect("manifest serialization");
            // Only the local part needs provider registrations from the client
            // catalog. Server dispatch keeps its private addresses on the server.
            if let Some(object) = value.as_object_mut() {
                object.remove("pluginFunctions");
                if let Some(Value::Array(providers)) = object.get_mut("contractProviders") {
                    providers.retain(|provider| provider["place"] == "local");
                }
            }
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

fn artifact_directory(root: &Path) -> Option<PathBuf> {
    if root.join("manifest.json").is_file() {
        Some(root.to_owned())
    } else if root.join("dist/manifest.json").is_file() {
        Some(root.join("dist"))
    } else {
        None
    }
}
