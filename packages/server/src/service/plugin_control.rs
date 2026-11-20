use super::*;

impl Coordinator {
    pub(super) fn metadata(&self) -> Result<Json, Error> {
        let plugins = self.plugins.as_ref().ok_or_else(|| {
            Error::Invalid("Server uses a legacy bundle, not a plugin installation".into())
        })?;

        let mut metadata = plugins.catalog.metadata();
        metadata["functions"] = plugins.descriptor["functions"].clone();
        metadata["schema"] = plugins.descriptor["schema"].clone();

        Ok(metadata)
    }

    pub(super) fn catalog_page(&self, revision: Option<&str>, offset: u64) -> Result<Json, String> {
        let loaded = self.plugins.as_ref().ok_or("No plugin installation")?;

        if revision.is_some_and(|r| r != loaded.catalog.revision) {
            return Err("Plugin generation changed".into());
        }
        // Serialize once per generation, rather than once per page (quadratic
        // in catalog size). Paging bounds wire memory, never plugin count.
        let text = &loaded.catalog_text;

        let start = usize::try_from(offset).map_err(|_| "Invalid catalog offset")?;

        if start > text.len() || !text.is_char_boundary(start) {
            return Err("Invalid catalog offset".into());
        }
        // Byte pages also bound a single unusually large manifest. Escaping can
        // expand 8 KiB at most sixfold, safely below either transport's cap.
        let mut end = (start + 8192).min(text.len());

        while !text.is_char_boundary(end) {
            end -= 1;
        }

        Ok(
            serde_json::json!({"revision":loaded.catalog.revision, "text":&text[start..end], "next":end,"done":end == text.len()}),
        )
    }

    pub(super) async fn control(&mut self, command: Command) {
        match command {
            Command::RenameUser(user, reply) => {
                for client in self.sessions.values_mut() {
                    let mut current = client.user.write().expect("user lock");
                    if current.id == user.id {
                        *current = user.clone();
                    }
                }
                let _ = reply.send(());
            }
            Command::RunFunction(call) => self.run_function(call).await,
            Command::Plugins(reply) => {
                let _ = reply.send(self.metadata());
            }
            Command::Asset(revision, id, name, reply) => {
                let result = self
                    .plugins
                    .as_ref()
                    .ok_or_else(|| Error::Invalid("No plugin installation".into()))
                    .map(|loaded| {
                        loaded
                            .catalog
                            .plugins
                            .get(&id)
                            .filter(|plugin| {
                                revision.as_ref().is_none_or(|r| r == &plugin.build_id)
                            })
                            .and_then(|plugin| plugin.ui_asset(&name))
                    });

                let _ = reply.send(result);
            }
            Command::Reload(id, reply) => {
                let result = self.reload(&id).await;

                let _ = reply.send(result);
            }
            Command::ReloadIndexed(ids, remove_missing, reply) => {
                let _ = reply.send(self.reload_indexed(&ids, remove_missing).await);
            }
            _ => unreachable!("application commands have their own admission path"),
        }
    }

    async fn reload_indexed(
        &mut self,
        ids: &[String],
        remove_missing: bool,
    ) -> Result<Json, Error> {
        let root = self
            .plugin_root
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;
        let previous = self
            .plugins
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;
        let catalog = crate::plugins::Catalog::read_indexed_reload(
            root,
            &previous.catalog,
            ids,
            remove_missing,
        )?;
        self.swap_catalog(catalog).await
    }

    async fn reload(&mut self, id: &str) -> Result<Json, Error> {
        let root = self
            .plugin_root
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;

        let catalog =
            crate::plugins::Catalog::read_reusing(root, self.plugins.as_ref().map(|p| &p.catalog))?;

        if !catalog.plugins.contains_key(id)
            && !self
                .plugins
                .as_ref()
                .is_some_and(|loaded| loaded.catalog.plugins.contains_key(id))
        {
            return Err(Error::Invalid(format!("Plugin is not installed: {id}")));
        }

        self.swap_catalog(catalog).await
    }

    async fn swap_catalog(&mut self, catalog: crate::plugins::Catalog) -> Result<Json, Error> {
        if self
            .plugins
            .as_ref()
            .is_some_and(|old| old.catalog.revision == catalog.revision)
        {
            return self.metadata();
        }

        let candidate =
            crate::plugins::Loaded::load_reusing(catalog, &self.pool, self.plugins.as_deref())
                .await?;
        let mut changed = std::collections::BTreeSet::new();
        if let Some(previous) = &self.plugins {
            for (id, artifact) in &previous.catalog.plugins {
                if candidate
                    .catalog
                    .plugins
                    .get(id)
                    .is_none_or(|next| artifact.build_id != next.build_id)
                {
                    changed.insert(id.clone());
                }
            }
            for id in candidate.catalog.plugins.keys() {
                if !previous.catalog.plugins.contains_key(id) {
                    changed.insert(id.clone());
                }
            }
        }

        Box::pin(candidate.record_grants(&self.database, self.plugins.as_deref())).await?;
        // All fallible preparation is complete. No requests can observe a
        // partial swap while the coordinator retires the changed builds.
        if let Some(previous) = &self.plugins {
            for id in &changed {
                if let Some(lifetime) = previous.action_lifetimes.get(id) {
                    lifetime.cancel();
                }
            }
            for id in &changed {
                if let Some(worker) = previous.workers.get(id) {
                    worker.stop().await;
                }
            }
        }
        self.kinds = candidate.client_kinds();
        self.plugins = Some(candidate);

        let catalog = self.metadata()?;
        // Use the same bounded ordered stream as data updates. Asset requests
        // carry the plugin's build id so they cannot mix builds.
        for session in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.emit(
                session,
                Event::PluginChanged {
                    plugins: changed.iter().cloned().collect(),
                    catalog: serde_json::json!({"revision": catalog["revision"], "paged": true}),
                },
            );
        }
        self.invalidate(None);
        self.refresh().await;
        self.metadata()
    }

    pub(super) fn asset_page(
        &mut self,
        session: u64,
        id: u64,
        plugin: String,
        name: String,
        revision: String,
        offset: u64,
    ) {
        let result = (|| {
            let loaded = self.plugins.as_ref().ok_or("No plugin installation")?;

            let plugin = loaded
                .catalog
                .plugins
                .get(&plugin)
                .ok_or("Unknown plugin")?;
            if plugin.build_id != revision {
                return Err("Plugin build changed".to_owned());
            }

            let bytes = plugin.ui_asset(&name).ok_or("Unknown plugin UI asset")?;
            bytes.page(offset).map_err(|e| e.to_string())
        })();
        self.respond(session, id, result);
    }
}
