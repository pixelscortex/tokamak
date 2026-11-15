use super::*;

impl Coordinator {
    pub(super) async fn action(&mut self, session: u64, action: Action) {
        // Admission transfers call ownership to the coordinator. Disconnect
        // retires subscriptions and delivery, not accepted mutations waiting in
        // the command queue. Shutdown must drain those calls too.
        if !self.sessions.contains_key(&session) && !matches!(&action, Action::Call { .. }) {
            return;
        }
        match action {
            Action::Plugins(id) => {
                let result = self.catalog_page(None, 0);
                self.emit(
                    session,
                    Event::Response {
                        id,
                        result,
                    },
                );
            }
            Action::PluginsPage {
                id,
                revision,
                offset,
            } => {
                let result = self.catalog_page(Some(&revision), offset);
                self.emit(
                    session,
                    Event::Response {
                        id,
                        result,
                    },
                );
            }
            Action::PluginAsset {
                id,
                plugin,
                name,
                revision,
                offset,
            } => {
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
                self.emit(
                    session,
                    Event::Response {
                        id,
                        result,
                    },
                );
            }
            Action::Call {
                id,
                name,
                args,
                kind: expected,
            } => {
                let result = match self.kinds.get(&name).copied() {
                    None => Err(format!("unknown function: {name}")),
                    Some(kind) if expected.is_some_and(|expected| expected != kind) => {
                        Err("function kind does not match request".into())
                    }
                    Some(FunctionKind::Action) => {
                        self.start_action(session, id, name, args);
                        return;
                    }
                    Some(kind) => {
                        let mutation = kind == FunctionKind::Mutation;
                        let mut result = Err("mutation conflict retry limit exceeded".into());
                        let determinism = engine::Determinism::default();
                        for attempt in 0..ATTEMPTS {
                            let call = host::invoke(
                                &self.database,
                                &self.pool,
                                self.bundle.clone(),
                                &name,
                                args.clone(),
                                mutation,
                                &self.space,
                                self.plugins.clone(),
                                determinism,
                            )
                            .await;
                            if mutation && call.conflict {
                                if attempt + 1 == ATTEMPTS {
                                    break;
                                }
                                continue; // New transaction AND fresh JS world for the whole handler.
                            }
                            result = call.result;
                            break;
                        }
                        result
                    }
                };
                self.drain_changes();
                self.refresh().await; // Writer barrier precedes response on the SAME queue.
                self.emit(
                    session,
                    Event::Response {
                        id,
                        result,
                    },
                );
            }
            Action::Subscribe {
                id,
                name,
                args,
            } => {
                let client = self.sessions.get_mut(&session).expect("checked session");
                let error = if self.kinds.get(&name) != Some(&FunctionKind::Query) {
                    Some("subscriptions require a registered query")
                } else if client.subscriptions.contains_key(&id) {
                    Some("subscription ID already in use")
                } else if client.subscriptions.len() >= SUBSCRIPTIONS {
                    Some("subscription capacity exceeded")
                } else {
                    None
                };
                if let Some(error) = error {
                    // Invalid registration never replaces an existing subscription.
                    self.emit(
                        session,
                        Event::Response {
                            id,
                            result: Err(error.into()),
                        },
                    );
                    return;
                }
                client.subscriptions.insert(
                    id,
                    Subscription {
                        name,
                        args,
                        reads: ReadSet::new(),
                        last: None,
                        dirty: true,
                        uncertain: true,
                    },
                );
                self.drain_changes();
                self.refresh().await;
            }
            Action::Unsubscribe(id) => {
                self.sessions.get_mut(&session).expect("checked session").subscriptions.remove(&id);
                self.emit(
                    session,
                    Event::Unsubscribed {
                        id,
                    },
                );
            }
        }
    }
}
