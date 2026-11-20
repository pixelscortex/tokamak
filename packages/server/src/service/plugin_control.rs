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
            _ => unreachable!("application commands have their own admission path"),
        }
    }

    pub(super) async fn reload(&mut self, id: &str) -> Result<Json, Error> {
        let root = self
            .plugin_root
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;

        let previous = self.plugins.as_deref();
        let (catalog, artifact_failures) =
            crate::plugins::Catalog::read_for_reload(root, previous)?;

        if !catalog.plugins.contains_key(id)
            && !previous.is_some_and(|old| {
                old.catalog.plugins.contains_key(id) || old.skipped.contains_key(id)
            })
        {
            return Err(Error::Invalid(format!("Plugin is not installed: {id}")));
        }

        if previous
            .is_some_and(|old| old.skipped.is_empty() && old.catalog.revision == catalog.revision)
        {
            return self.metadata();
        }

        let mut candidate =
            crate::plugins::Loaded::load_reusing(catalog, artifact_failures, &self.pool, previous)
                .await?;
        Box::pin(candidate.record_grants(&self.database, previous)).await?;
        let changed = candidate.changed_plugins(previous);
        let revision_changed =
            previous.is_none_or(|old| old.catalog.revision != candidate.catalog.revision);
        // An empty report marks recovery when the previous load had skips.
        let skipped = (previous.is_some_and(|old| !old.skipped.is_empty())
            || !candidate.skipped.is_empty())
        .then(|| serde_json::json!(candidate.skipped));
        let candidate = Arc::new(candidate);
        // Backfill and readiness have both passed for the remaining candidates.
        // Retire only builds that differ in the catalog we will publish.
        candidate.publish(previous, &changed).await;
        self.kinds = candidate.client_kinds();
        self.plugins = Some(candidate);

        let mut catalog = self.metadata()?;
        if let Some(skipped) = skipped {
            catalog["skipped"] = skipped;
        }
        if revision_changed || !changed.is_empty() {
            // Windows fetch a changed catalog even when no builds need to remount.
            for session in self.sessions.keys().copied().collect::<Vec<_>>() {
                self.emit(
                    session,
                    Event::PluginChanged {
                        plugins: changed.iter().cloned().collect(),
                        catalog: serde_json::json!({"revision": catalog["revision"], "paged": true}),
                    },
                );
            }
        }
        if !changed.is_empty() {
            self.invalidate(None);
            self.refresh().await;
        }
        Ok(catalog)
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
