use super::*;

pub(super) const TRANSACTIONS: &str = "transactions.js";
pub(super) const TRANSACTIONS_MAP: &str = "transactions.js.map";

impl Artifact {
    pub fn read(directory: &Path) -> Result<Self, Error> {
        Self::read_reusing(directory, None, false)
    }

    pub(super) fn read_reusing(
        directory: &Path,
        previous: Option<&Artifact>,
        quickjs: bool,
    ) -> Result<Self, Error> {
        let root = directory
            .canonicalize()
            .map_err(|e| invalid(e.to_string()))?;

        let manifest = Manifest::read(&root)?;

        let names = manifest.validate()?;
        let transactions = [TRANSACTIONS, TRANSACTIONS_MAP];
        if quickjs
            && (manifest.hashes.contains_key(TRANSACTIONS)
                != manifest.hashes.contains_key(TRANSACTIONS_MAP))
        {
            let missing = if manifest.hashes.contains_key(TRANSACTIONS) {
                TRANSACTIONS_MAP
            } else {
                TRANSACTIONS
            };
            return Err(invalid(format!(
                "Incomplete transaction bundle: no hash for {missing}; rebuild this plugin"
            )));
        }

        let mut assets = BTreeMap::new();

        for name in names {
            let whole_backend = manifest
                .entries
                .server
                .as_ref()
                .is_some_and(|entry| name == &entry.code || name == &entry.map);
            assets.insert(
                name.clone(),
                asset(&root, name, &manifest.hashes, previous, whole_backend)?,
            );
        }

        if quickjs && manifest.hashes.contains_key(TRANSACTIONS) {
            for name in transactions {
                assets.insert(
                    name.to_owned(),
                    asset(&root, name, &manifest.hashes, previous, true)?,
                );
            }
        }

        let bundle = manifest
            .entries
            .server
            .as_ref()
            .map(|entry| {
                if let Some(previous) = previous
                    && let Some(old) = &previous.manifest.entries.server
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

        let permissions = manifest.plugin.permissions.iter().cloned().collect();

        Ok(Self {
            manifest,
            bundle,
            assets,
            permissions,
        })
    }

    pub(super) async fn transactions(&self) -> Result<Option<Arc<Bundle>>, Error> {
        if let (Some(code), Some(map)) = (
            self.assets.get(TRANSACTIONS),
            self.assets.get(TRANSACTIONS_MAP),
        ) {
            return Bundle::new(
                code.backend_text(TRANSACTIONS)?,
                Some(&map.backend_text(TRANSACTIONS_MAP)?),
            )
            .map(|bundle| Some(Arc::new(bundle)))
            .map_err(|error| invalid(error.to_string()));
        }
        if let Some(entry) = self.manifest.entries.server.as_ref()
            && self.manifest.entries.worker.is_none()
            && crate::host::action_process::inspect_legacy(self.assets[&entry.code].path())
                .await
                .map_err(invalid)?
        {
            return Err(invalid(
                "QuickJS actions require a transaction bundle; rebuild this plugin",
            ));
        }
        Ok(self.bundle.clone())
    }

    pub(super) fn action_source(
        &self,
        id: &str,
    ) -> Result<Arc<crate::host::action_process::Source>, Error> {
        let (code, bundle, worker_entry) = if let Some(entry) = &self.manifest.entries.worker {
            let source = self.assets[&entry.code].backend_text(&entry.code)?;
            let map = self.assets[&entry.map].backend_text(&entry.map)?;
            let bundle =
                Bundle::new(source, Some(&map)).map_err(|error| invalid(error.to_string()))?;
            (self.assets[&entry.code].clone(), Arc::new(bundle), true)
        } else {
            let entry = self
                .manifest
                .entries
                .server
                .as_ref()
                .ok_or_else(|| invalid("Missing server action bundle"))?;
            let bundle = self
                .bundle
                .clone()
                .ok_or_else(|| invalid("Missing server action bundle"))?;
            (self.assets[&entry.code].clone(), bundle, false)
        };
        Ok(crate::host::action_process::Source::plugin(
            id,
            code,
            bundle,
            worker_entry,
        ))
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
