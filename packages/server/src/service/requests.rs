use super::*;

impl Coordinator {
    pub(super) async fn action(&mut self, session: u64, auth: SessionAuth, action: Action) {
        // Admission transfers call ownership to the coordinator. Disconnect
        // retires subscriptions and delivery, not accepted mutations waiting in
        // the command queue. Shutdown must drain those calls too.
        if !self.sessions.contains_key(&session) && !matches!(&action, Action::Call { .. }) {
            return;
        }

        match action {
            Action::Plugins(id) => {
                let result = self.catalog_page(None, 0);
                self.respond(session, id, result);
            }
            Action::PluginsPage {
                id,
                revision,
                offset,
            } => {
                let result = self.catalog_page(Some(&revision), offset);
                self.respond(session, id, result);
            }
            Action::PluginAsset {
                id,
                plugin,
                name,
                revision,
                offset,
            } => {
                self.asset_page(session, id, plugin, name, revision, offset);
            }
            Action::Call {
                id,
                name,
                args,
                kind: expected,
                local_parent,
            } => {
                // A socket may already have admitted a write when its member
                // was revoked. It must not recreate rows after cleanup.
                if name == window_state::WRITE && auth.revoked.is_cancelled() {
                    self.respond(session, id, Err("Session has been revoked".into()));
                    return;
                }
                let auth = auth.caller.read().expect("auth lock").clone();
                let note = match local_parent {
                    Some((depth, thread)) => {
                        match crate::identity::CallNote::from_local_parent(&auth, depth, thread)
                            .and_then(|parent| {
                                let validator = self
                                    .plugins
                                    .as_ref()
                                    .and_then(|loaded| loaded.targets.get(&name))
                                    .map(|target| target.args.as_ref());
                                parent.enter(&name, validator, &args)
                            }) {
                            Ok(note) => note,
                            Err(error) => {
                                self.respond(session, id, Err(error));
                                return;
                            }
                        }
                    }
                    None => Some(auth.clone()).into(),
                };
                self.call(session, id, name, args, expected, (auth, note))
                    .await;
            }
            Action::Subscribe { id, name, args } => {
                self.subscribe(session, id, name, args).await;
            }
            Action::Unsubscribe(id) => {
                self.sessions
                    .get_mut(&session)
                    .expect("checked session")
                    .subscriptions
                    .remove(&id);
                self.emit(session, Event::Unsubscribed { id });
            }
        }
    }

    async fn call(
        &mut self,
        session: u64,
        id: u64,
        name: String,
        args: Json,
        expected: Option<FunctionKind>,
        (auth, note): (crate::identity::AuthContext, crate::identity::CallNote),
    ) {
        if let Some(query) = builtin_queries::resolve(&name, &args) {
            let result = if expected.is_none_or(|kind| kind == FunctionKind::Query) {
                query.map(|read| read(&auth)).map_err(str::to_owned)
            } else {
                Err("auth caller identity requires a query".into())
            };
            self.respond(session, id, result);
            return;
        }
        if name == "tokamak:whoami" {
            let result = if expected.is_none_or(|kind| kind == FunctionKind::Query)
                && args == serde_json::json!({})
            {
                Ok(serde_json::json!(auth.user))
            } else {
                Err("whoami requires a query with empty arguments".into())
            };
            self.respond(session, id, result);
            return;
        }
        if matches!(name.as_str(), window_state::READ | window_state::WRITE) {
            // Keep the database transaction future off the coordinator's stack.
            let result = Box::pin(window_state::call(
                &self.database,
                self.plugins.as_ref().map(|loaded| &loaded.catalog),
                &auth.user.id,
                &name,
                expected,
                args,
            ))
            .await;
            self.respond(session, id, result);
            return;
        }
        let result = match self.client_kind(&name) {
            None => Err(format!("unknown function: {name}")),
            Some(kind) if expected.is_some_and(|expected| expected != kind) => {
                Err("function kind does not match request".into())
            }
            Some(FunctionKind::Action) => {
                self.start_action(session, note, id, name, args);
                return;
            }
            Some(kind) => {
                self.invoke_function_in(
                    self.plugins.clone(),
                    &name,
                    args,
                    kind == FunctionKind::Mutation,
                    note,
                )
                .await
            }
        };
        self.drain_changes();
        self.refresh().await; // Writer barrier precedes response on the SAME queue.
        self.respond(session, id, result);
    }
}
