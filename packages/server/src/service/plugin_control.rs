use super::*;
use crate::plugins::package::{PackageChange, StagedPackage, Upload};

impl Coordinator {
    pub(super) fn metadata(&self) -> Result<Json, Error> {
        let plugins = self.plugins.as_ref().ok_or_else(|| {
            Error::Invalid("Server uses a legacy bundle, not a plugin installation".into())
        })?;

        let mut metadata = plugins.catalog.metadata_with_logs(&plugins.logs);
        metadata["functions"] = plugins.descriptor["functions"].clone();
        metadata["schema"] = plugins.descriptor["schema"].clone();

        if !plugins.skipped.is_empty() {
            metadata["skipped"] = serde_json::json!(plugins.skipped);
        }
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
                        loaded
                            .catalog
                            .plugins
                            .get(&id)
                            .filter(|plugin| {
                                revision.as_ref().is_none_or(|r| r == &plugin.build_id)
                            })
                            .and_then(|plugin| {
                                plugin.ui_asset(&name).or_else(|| plugin.types_asset(&name))
                            })
                    });

                let _ = reply.send(result);
            }
            Command::Reload(id, reply) => {
                let result = self.reload(&id).await;

                let _ = reply.send(result);
            }
            Command::RemovePlugin(id, reply) => {
                let _ = reply.send(self.remove_plugin(&id).await);
            }
            Command::UploadPackage(upload, reply) => {
                let _ = reply.send(self.upload_package(upload).await);
            }
            Command::ReloadIndexed(request, reply) => {
                let _ = reply.send(self.reload_indexed(&request).await);
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

    async fn reload_indexed(
        &mut self,
        request: &crate::plugins::IndexedReload,
    ) -> Result<ReloadResult, Error> {
        let root = self
            .plugin_root
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;
        let previous = self
            .plugins
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;
        let (catalog, failures) =
            crate::plugins::Catalog::read_indexed_reload(root, previous, request)?;
        let unchanged: Vec<_> = request
            .builds
            .iter()
            .filter(|build| {
                previous
                    .catalog
                    .plugins
                    .get(&build.id)
                    .is_some_and(|artifact| artifact.build_id == build.build_id)
            })
            .map(|build| build.id.clone())
            .collect();
        let removed: Vec<_> = previous
            .catalog
            .index
            .keys()
            .filter(|id| !catalog.index.contains_key(*id))
            .cloned()
            .collect();
        let (mut response, logs) = self.swap_catalog(catalog, failures, None).await?;
        // Diagnostics run after the swap. Unrelated on-disk errors do not
        // participate in deciding or applying an index removal.
        if !removed.is_empty()
            && let Some(root) = &self.plugin_root
        {
            let warnings = crate::plugins::Catalog::installation_warnings(root);
            if !warnings.is_empty() {
                response["warnings"] = serde_json::json!(warnings);
            }
        }
        response["removed"] = serde_json::json!(removed);
        response["unchanged"] = serde_json::json!(unchanged);
        Ok((response, logs))
    }

    pub(super) async fn reload(&mut self, id: &str) -> Result<ReloadResult, Error> {
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

        self.swap_catalog(catalog, artifact_failures, None).await
    }

    async fn upload_package(&mut self, upload: Upload) -> Result<ReloadResult, Error> {
        let root = self
            .plugin_root
            .as_deref()
            .ok_or_else(|| Error::Invalid("No plugin installation to update".into()))?;
        let previous = self
            .plugins
            .as_deref()
            .ok_or_else(|| Error::Invalid("No plugin installation to update".into()))?;
        let directory = previous
            .catalog
            .package_root
            .as_ref()
            .ok_or_else(|| Error::Invalid("Packages require a server data folder".into()))?;
        let id = upload.id.clone();
        crate::data::DataSpace::plugin(&id).map_err(|error| Error::Invalid(error.to_string()))?;
        let current = previous.catalog.plugins.get(&id);
        let directory = directory.clone();
        let old_artifact = current.cloned();
        let (staged, artifact) = tokio::task::spawn_blocking(move || {
            StagedPackage::read(&directory, upload, old_artifact.as_deref())
        })
        .await
        .map_err(|error| Error::Invalid(error.to_string()))??;
        let status = if current.is_some_and(|current| current.build_id == artifact.build_id) {
            "unchanged"
        } else if current.is_some() || previous.skipped.contains_key(&id) {
            "updated"
        } else {
            "installed"
        };
        let response = serde_json::json!({
            "status": status, "id": id,
            "version": artifact.manifest.plugin.version, "buildId": artifact.build_id
        });
        if status == "unchanged" {
            return Ok((response, Vec::new()));
        }
        if previous.catalog.index.contains_key(&id) {
            return Err(Error::Invalid(format!(
                "Plugin {id} is managed by the local plugin index"
            )));
        }
        let (catalog, failures) =
            crate::plugins::Catalog::with_package(root, previous, &id, artifact)?;
        let (_, logs) = self
            .swap_catalog(
                catalog,
                failures,
                Some((&id, PackageChange::Upload(Arc::new(staged)))),
            )
            .await?;
        Ok((response, logs))
    }

    async fn remove_plugin(&mut self, id: &str) -> Result<ReloadResult, Error> {
        let not_found = || Error::Invalid(format!("Plugin not found: {id}"));
        crate::data::DataSpace::plugin(id).map_err(|_| not_found())?;
        let previous = self.plugins.as_deref().ok_or_else(not_found)?;
        let root = self.plugin_root.as_deref().ok_or_else(not_found)?;
        let package_root = previous
            .catalog
            .removable_package(id, &previous.skipped)?
            .to_owned();
        let (catalog, failures) = crate::plugins::Catalog::without_package(root, previous, id)?;
        let response = match catalog.plugins.get(id) {
            Some(artifact) => serde_json::json!({
                "id": id, "removed": false, "reverted": true, "buildId": artifact.build_id,
            }),
            None => serde_json::json!({"id": id, "removed": true}),
        };
        let (_, logs) = self
            .swap_catalog(
                catalog,
                failures,
                Some((
                    id,
                    PackageChange::Remove {
                        root: package_root,
                        id: id.to_owned(),
                    },
                )),
            )
            .await?;
        Ok((response, logs))
    }

    async fn swap_catalog(
        &mut self,
        catalog: crate::plugins::Catalog,
        artifact_failures: std::collections::BTreeMap<String, String>,
        package: Option<(&str, PackageChange)>,
    ) -> Result<ReloadResult, Error> {
        let previous = self.plugins.as_deref();
        if package.is_none()
            && previous.is_some_and(|old| {
                old.skipped.is_empty() && old.catalog.revision == catalog.revision
            })
        {
            return Ok((self.metadata()?, Vec::new()));
        }

        let mut candidate =
            crate::plugins::Loaded::load_reusing(catalog, artifact_failures, &self.pool, previous)
                .await?;
        if let Some((id, _)) = &package
            && let Some(reason) = candidate.skipped.get(*id)
        {
            return Err(Error::Invalid(reason.clone()));
        }
        Box::pin(candidate.record_grants(
            &self.database,
            previous,
            package.map(|(_, staged)| staged),
        ))
        .await?;
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
        let logs = changed
            .iter()
            .filter_map(|id| candidate.logs.get(id).cloned())
            .collect();
        self.window_reports.retain(|id, _| !changed.contains(id));
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
        Ok((catalog, logs))
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
