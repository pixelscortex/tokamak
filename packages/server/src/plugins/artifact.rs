use super::*;

impl Artifact {
    pub fn read(directory: &Path) -> Result<Self, Error> {
        Self::read_reusing(directory, None)
    }

    pub(super) fn read_reusing(
        directory: &Path,
        previous: Option<&Artifact>,
    ) -> Result<Self, Error> {
        let root = directory
            .canonicalize()
            .map_err(|e| invalid(e.to_string()))?;

        let manifest = Manifest::read(&root)?;

        let names = manifest.validate()?;

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
                if let Some(previous) = previous
                    && let Some(old) = &previous.manifest.entries.backend
                    && old.code == entry.code
                    && old.map == entry.map
                    && manifest.hashes.get(&entry.code) == previous.manifest.hashes.get(&old.code)
                    && manifest.hashes.get(&entry.map) == previous.manifest.hashes.get(&old.map)
                {
                    return Ok(previous.bundle.clone().expect("backend bundle"));
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
        [&ui.code, &ui.map]
            .into_iter()
            .chain(ui.css.iter())
            .chain(ui.shell.iter())
            .any(|file| file.as_str() == name)
            .then(|| self.assets.get(name).cloned())
            .flatten()
    }
}
