use super::*;

impl Coordinator {
    pub(super) fn metadata(&self) -> Result<Json, Error> {
        let plugins = self.plugins.as_ref().ok_or_else(|| {
            Error::Invalid("Server uses a legacy bundle, not a plugin installation".into())
        })?;

        let mut metadata = plugins.catalog.metadata_with_logs(&plugins.logs);
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
            Command::WindowError(id, revision, text, reply) => {
                let result = self.record_window_error(id, &revision, &text);
                let _ = reply.send(result);
            }
            Command::Plugins(reply) => {
                let _ = reply.send(self.metadata());
            }
            Command::Asset(revision, id, name, reply) => {
                let result = self
                    .plugins
                    .as_ref()
                    .ok_or_else(|| Error::Invalid("No plugin installation".into()))
                    .map(|loaded| {
                        if revision
                            .as_ref()
                            .is_some_and(|r| r != &loaded.catalog.revision)
                        {
                            return None;
                        }
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

    fn record_window_error(
        &mut self,
        id: String,
        revision: &str,
        text: &str,
    ) -> Result<bool, Error> {
        use std::time::{Duration, Instant};
        let Some(log) = self.plugins.as_ref().and_then(|p| p.logs.get(&id)) else {
            return Ok(false);
        };
        if log.revision() != revision {
            return Err(Error::Invalid("Stale plugin log revision".into()));
        }
        // Keep a runaway view from filling the disk with repeated reports.
        let (start, count) = self
            .window_reports
            .entry(id.clone())
            .or_insert_with(|| (Instant::now(), 0));
        if start.elapsed() >= Duration::from_secs(10) {
            *start = Instant::now();
            *count = 0;
        }
        if *count >= 8 {
            if *count == 8 {
                log.record(
                    "window",
                    "warn",
                    "dropped",
                    "window report rate limit reached; further reports dropped",
                );
                *count += 1;
            }
            return Err(Error::Overloaded);
        }
        log.record("window", "error", "exception", text);
        *count += 1;
        Ok(true)
    }

    pub(super) async fn reload(
        &mut self,
        id: &str,
    ) -> Result<(Json, Vec<crate::plugin_log::Log>), Error> {
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

        let previous = self
            .plugins
            .as_deref()
            .ok_or_else(|| Error::Invalid("No plugin installation".into()))?;
        let candidate = crate::plugins::Loaded::load_reusing(
            catalog,
            &self.pool,
            Some(previous),
            &previous.log_folder,
            Some(id),
        )
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
        self.stop_actions().await;
        let logs: Vec<_> = candidate.logs.values().cloned().collect();
        for log in &logs {
            log.publish();
        }
        self.action_pool = action_pool;
        self.kinds = candidate.client_kinds();

        let mut changed = std::collections::BTreeSet::from([id.to_owned()]);

        if let Some(previous) = &self.plugins {
            for (id, artifact) in &previous.catalog.plugins {
                if candidate
                    .catalog
                    .plugins
                    .get(id)
                    .is_none_or(|next| artifact.manifest != next.manifest)
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
        self.window_reports
            .retain(|plugin, _| plugin != id && candidate.catalog.plugins.contains_key(plugin));
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
        Ok((self.metadata()?, logs))
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
