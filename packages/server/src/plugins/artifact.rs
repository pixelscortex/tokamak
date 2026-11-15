use super::*;

impl Artifact {
    pub fn read(directory: &Path) -> Result<Self, Error> {
        Self::read_reusing(directory, None)
    }
    pub(super) fn read_reusing(
        directory: &Path,
        previous: Option<&Artifact>,
    ) -> Result<Self, Error> {
        let root = directory.canonicalize().map_err(|e| invalid(e.to_string()))?;
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
            return Err(invalid(format!("Incompatible host API for {}", manifest.plugin.id)));
        }
        if !["hub", "runner", "hybrid"].contains(&manifest.plugin.placement.as_str()) {
            return Err(invalid("Invalid plugin placement"));
        }
        for map in [&manifest.plugin.depends, &manifest.plugin.optional, &manifest.plugin.breaks] {
            for (id, range) in map {
                DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
                VersionReq::parse(range)
                    .map_err(|e| invalid(format!("Invalid dependency range: {e}")))?;
            }
        }
        for list in
            [&manifest.plugin.provides, &manifest.plugin.consumes, &manifest.plugin.permissions]
        {
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
                Bundle::new(source, Some(&map)).map(Arc::new).map_err(|e| invalid(e.to_string()))
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
