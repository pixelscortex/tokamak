use super::*;
use crate::plugins::MemberEvent;

impl Coordinator {
    pub(super) fn metadata(&self) -> Result<Json, Error> {
        let plugins = self.plugins.as_ref().ok_or_else(|| {
            Error::Invalid("Server uses a legacy bundle, not a plugin installation".into())
        })?;

        let mut metadata = plugins.catalog.metadata();
        metadata["functions"] = plugins.descriptor["functions"].clone();
        metadata["schema"] = plugins.descriptor["schema"].clone();
        metadata["skipped"] = serde_json::json!(plugins.skipped);

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
            Command::UpdateUser(user, reply) => {
                for client in self.sessions.values_mut() {
                    let mut current = client.auth.caller.write().expect("auth lock");
                    if current.user.id != user.id || current.user == user {
                        continue;
                    }
                    current.user = user.clone();
                    for subscription in client.subscriptions.values_mut() {
                        subscription.dirty = true;
                    }
                }
                self.refresh().await;
                let _ = reply.send(());
            }
            Command::MemberAdded(user, reply) => {
                Box::pin(self.member_hooks(MemberEvent::Added, &user)).await;
                let _ = reply.send(());
            }
            Command::MemberRemoved { id, user, reply } => {
                let result = Box::pin(window_state::remove_users(&self.database, &[id])).await;
                if let Some(user) = user {
                    Box::pin(self.member_hooks(MemberEvent::Removed, &user)).await;
                }
                let _ = reply.send(result);
            }
            Command::MemberAccountAbandoned {
                user,
                cleanup,
                reply,
            } => {
                Box::pin(self.abandon_member_account(&user, cleanup)).await;
                let _ = reply.send(());
            }
            Command::RemoveUserWindowState(ids, reply) => {
                let result = Box::pin(window_state::remove_users(&self.database, &ids)).await;
                let _ = reply.send(result);
            }
            Command::RunFunction(call) => self.run_function(call).await,
            Command::Plugins(reply) => {
                let _ = reply.send(self.metadata());
            }
            Command::RunSignIn(request) => self.start_sign_in(request),
            Command::SignInMethods(reply) => {
                let result = match &self.plugins {
                    Some(loaded) => loaded.sign_in_methods(),
                    None => Ok(Vec::new()),
                };
                let _ = reply.send(result);
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

    async fn member_hooks(&mut self, event: MemberEvent, user: &crate::identity::User) {
        let Some(loaded) = self.plugins.clone() else {
            return;
        };
        let targets = loaded.member_hooks(event, None);
        self.run_member_hooks(event, user, loaded, targets).await;
    }

    async fn abandon_member_account(
        &mut self,
        user: &crate::identity::User,
        cleanup: sign_in::MemberAccountCleanup,
    ) {
        self.run_member_hooks(
            MemberEvent::Removed,
            user,
            cleanup.generation,
            cleanup.targets,
        )
        .await;
    }

    async fn run_member_hooks(
        &mut self,
        event: MemberEvent,
        user: &crate::identity::User,
        generation: Arc<crate::plugins::Loaded>,
        targets: Vec<String>,
    ) {
        let args = serde_json::json!(user);
        for target in targets {
            // Hooks run as private mutations so they can update plugin data
            // without borrowing the managing person's session or device.
            let result = Box::pin(self.invoke_function_in(
                Some(generation.clone()),
                &target,
                args.clone(),
                true,
                None,
            ))
            .await;
            if !matches!(result, Ok(value) if crate::protocol::failure_kind(&value).is_none()) {
                eprintln!(
                    "Membership hook failed: {} {target} member={:?}",
                    event.name(),
                    user.id
                );
            }
        }
        self.drain_changes();
        self.refresh().await;
    }

    pub(super) async fn reload(&mut self, id: &str) -> Result<Json, Error> {
        if id == "auth" {
            return Err(Error::Invalid("auth is built into the server".into()));
        }
        let root = self
            .plugin_root
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;

        let catalog = crate::plugins::Catalog::read_reusing(
            root,
            self.plugins.as_ref().map(|p| &p.catalog),
            self.action_process.is_some(),
        )?;

        if !catalog.plugins.contains_key(id)
            && !catalog.removed_plugins.iter().any(|removed| removed == id)
        {
            return Err(Error::Invalid(format!("Plugin is not installed: {id}")));
        }

        let mut candidate = crate::plugins::Loaded::load_reusing(
            catalog,
            &self.pool,
            self.plugins.as_deref(),
            self.action_process.is_some(),
            id,
        )
        .await?;
        // Each generation gets a fresh action lane; build it before the swap so
        // a pool failure leaves the current generation fully intact.
        let action_pool = if self.action_process.is_none() {
            Some(Arc::new(
                Pool::new_actions(PoolConfig {
                    limits: self.pool.limits().clone(),
                    ..PoolConfig::default()
                })
                .map_err(|e| Error::Invalid(e.to_string()))?,
            ))
        } else {
            None
        };
        Box::pin(candidate.record_grants(&self.database, self.plugins.as_deref())).await?;
        Box::pin(window_state::remove_plugins(
            &self.database,
            &candidate.catalog.removed_plugins,
        ))
        .await
        .map_err(Error::Invalid)?;
        candidate
            .catalog
            .persist_install_order(self.database.directory())?;
        // This command follows every previously accepted invocation's complete
        // commit/rollback. Nothing below can fail before the generation swap.
        self.retire_actions_for_reload(&candidate).await;
        self.action_pool = action_pool;
        self.kinds = candidate.client_kinds();

        let changed = self.changed_plugins(&candidate);
        self.plugins = Some(Arc::new(candidate));

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

    fn changed_plugins(
        &self,
        candidate: &crate::plugins::Loaded,
    ) -> std::collections::BTreeSet<String> {
        let Some(previous) = &self.plugins else {
            return Default::default();
        };
        previous
            .catalog
            .plugins
            .keys()
            .chain(candidate.catalog.plugins.keys())
            .filter(|id| !candidate.same_plugin(previous, id))
            .cloned()
            .collect()
    }

    async fn retire_actions_for_reload(&self, candidate: &crate::plugins::Loaded) {
        if let Some(pool) = &self.action_pool {
            pool.cancel_actions();
        }
        let Some(previous) = &self.plugins else {
            return;
        };
        #[cfg(feature = "local-runtime")]
        for worker in previous.workers.values() {
            worker.stop().await;
        }
        if let Some(process) = &self.action_process {
            for (id, source) in &previous.action_sources {
                if !candidate.same_action_source(previous, id) {
                    process.retire(source);
                }
            }
        }
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
