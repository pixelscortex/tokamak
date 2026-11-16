use super::*;

impl Coordinator {
    pub(super) fn guest_available(&self, name: &str) -> bool {
        if let Some(plugins) = &self.plugins {
            plugins.targets.get(name).is_some_and(|target| target.guest)
        } else {
            self.guest_functions.contains(name)
        }
    }

    pub(super) async fn action(&mut self, session: u64, caller: Caller, action: Action) {
        // Admission transfers call ownership to the coordinator. Disconnect
        // retires subscriptions and delivery, not accepted mutations waiting in
        // the command queue. Shutdown must drain those calls too.
        if !self.sessions.contains_key(&session)
            && (caller.is_guest() || !matches!(&action, Action::Call { .. }))
        {
            return;
        }

        if caller.is_guest() {
            match &action {
                Action::Call { id, name, .. } | Action::Subscribe { id, name, .. }
                    if !self.guest_available(name) =>
                {
                    self.respond(session, *id, Err("Not available to guests".into()));
                    return;
                }
                Action::Plugins(id) | Action::PluginsPage { id, .. } => {
                    self.respond(
                        session,
                        *id,
                        Ok(serde_json::json!({"revision":"guest","plugins":[]})),
                    );
                    return;
                }
                Action::PluginAsset { id, .. } => {
                    self.respond(session, *id, Err("Not available to guests".into()));
                    return;
                }
                _ => {}
            }
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
            } => {
                self.call(session, id, name, args, expected, caller).await;
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
        caller: Caller,
    ) {
        let result = match self.kinds.get(&name).copied() {
            None => Err(format!("unknown function: {name}")),
            Some(kind) if expected.is_some_and(|expected| expected != kind) => {
                Err("function kind does not match request".into())
            }
            Some(FunctionKind::Action) => {
                self.start_action(session, id, name, args, caller);
                return;
            }
            Some(kind) => {
                self.invoke_function(&name, args, kind == FunctionKind::Mutation, caller)
                    .await
            }
        };
        self.drain_changes();
        self.refresh().await; // Writer barrier precedes response on the SAME queue.
        self.respond(session, id, result);
    }
}
