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
            Command::RunFunction(call) => self.run_function(call).await,
            Command::Plugins(reply) => {
                let _ = reply.send(self.metadata());
            }
            Command::Asset(id, name, reply) => {
                let result = self
                    .plugins
                    .as_ref()
                    .ok_or_else(|| Error::Invalid("No plugin installation".into()))
                    .map(|loaded| {
                        loaded
                            .catalog
                            .plugins
                            .get(&id)
                            .and_then(|plugin| plugin.ui_asset(&name))
                    });

                let _ = reply.send(result);
            }
            Command::Reload(id, reply) => {
                let result = self.reload(&id).await;

                let _ = reply.send(result);
            }
            _ => unreachable!("application commands have their own admission path"),
        }
    }

    pub(super) async fn reload(&mut self, id: &str) -> Result<Json, Error> {
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

        let candidate =
            crate::plugins::Loaded::load_reusing(catalog, &self.pool, self.plugins.as_deref())
                .await?;
        // Each generation gets a fresh action lane; build it before the swap so
        // a pool failure leaves the current generation fully intact.
        let action_pool = Arc::new(
            Pool::new_actions(PoolConfig {
                limits: self.pool.limits().clone(),
                ..PoolConfig::default()
            })
            .map_err(|e| Error::Invalid(e.to_string()))?,
        );
        Box::pin(candidate.record_grants(&self.database, self.plugins.as_deref())).await?;
        // This command follows every previously accepted invocation's complete
        // commit/rollback. Nothing below can fail before the generation swap.
        // Cancel old-generation actions so a reload cannot leave revoked network
        // grants running in old worlds; the old pool tears down detached.
        self.action_pool.cancel_actions();
        self.action_pool = action_pool;
        self.kinds = candidate
            .targets
            .iter()
            .map(|(name, target)| (name.clone(), target.kind))
            .collect();

        let mut changed = std::collections::BTreeSet::new();

        if let Some(previous) = &self.plugins {
            for (id, artifact) in &previous.catalog.plugins {
                if candidate.catalog.plugins.get(id).is_none_or(|next| {
                    serde_json::to_value(&artifact.manifest).ok()
                        != serde_json::to_value(&next.manifest).ok()
                }) {
                    changed.insert(id.clone());
                }
            }

            for id in candidate.catalog.plugins.keys() {
                if !previous.catalog.plugins.contains_key(id) {
                    changed.insert(id.clone());
                }
            }
        }
        self.plugins = Some(candidate);

        let catalog = self.metadata()?;
        // Use the same bounded ordered stream as data updates. A stale asset
        // request carries its catalog revision and cannot mix generations.
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

            if loaded.catalog.revision != revision {
                return Err("Plugin generation changed".to_owned());
            }

            let bytes = loaded
                .catalog
                .plugins
                .get(&plugin)
                .and_then(|p| p.ui_asset(&name))
                .ok_or("Unknown plugin UI asset")?;
            bytes.page(offset).map_err(|e| e.to_string())
        })();
        self.respond(session, id, result);
    }
}
