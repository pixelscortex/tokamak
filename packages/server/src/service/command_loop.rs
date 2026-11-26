use super::*;

impl Coordinator {
    pub(super) async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        mut closing: mpsc::Receiver<oneshot::Sender<Result<(), Error>>>,
    ) {
        let mut maintenance = tokio::time::interval(std::time::Duration::from_secs(5));
        maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            self.sessions.retain(|_, client| !client.output.is_closed());
            tokio::select! {
                Some(reply) = closing.recv() => {
                    // Active native transactions remain finishable on Busy.
                    // No database owner can create a new one behind our check.
                    if self.database.has_transactions() {
                        let _ = reply.send(Err(Error::Invalid(crate::data::Error::Busy.to_string())));
                        continue;
                    }
                    commands.close();
                    // Finish every accepted command before the SDK lock-release
                    // barrier, even when the caller of close has disappeared.
                    while let Some(command) = commands.recv().await {
                        match command {
                            Command::Action(session, user, action) => self.action(session, user, action).await,
                            Command::Connect(_, reply) => {
                                let _ = reply.send(Err(Error::Closed));
                            }
                            command => self.control(command).await,
                        }
                    }
                    self.stop_actions().await;

                    let result = Box::pin(self.database.close())
                        .await
                        .map_err(|e| Error::Invalid(e.to_string()));
                    self.closed.send_replace(Some(result.clone()));

                    let _ = reply.send(result);
                    return;
                }
                Some(completion) = self.action_jobs.join_next() => {
                    if let Ok((session, id, result)) = completion {
                        self.action_cancellations.remove(&(session, id));
                        self.respond_call(session, id, result);
                    }
                }
                _ = self.cleanup.notified() => {},
                _ = maintenance.tick(), if self.plugins.is_some() => self.maintain_plugins().await,
                change = self.changes.recv() => {
                    match change {
                        Ok(change) => self.invalidate(Some(&change)),
                        Err(broadcast::error::RecvError::Lagged(_)) => self.invalidate(None),
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                    self.refresh().await;
                }
                command = commands.recv() => match command {
                    Some(Command::Connect(auth, reply)) => {
                        if self.sessions.len() >= SESSIONS || self.next_session == u64::MAX {
                            let _ = reply.send(Err(Error::Overloaded));
                            continue;
                        }
                        self.next_session += 1;

                        let id = self.next_session;

                        let (output, receiver) = mpsc::channel(OUTPUTS);

                        let slow = Arc::new(AtomicBool::new(false));

                        let alive = output.downgrade();
                        self.sessions.insert(id, Client {
                            auth,
                            output,
                            slow: slow.clone(),
                            subscriptions: BTreeMap::new(),
                            hook_scopes: BTreeMap::new(),
                            window_notes: Default::default(),
                        });

                        if reply.send(Ok((id, receiver, slow, alive))).is_err() {
                            self.sessions.remove(&id);
                        }
                    }
                    Some(Command::Action(session, auth, action)) => self.action(session, auth, action).await,
                    Some(command) => self.control(command).await,
                    None => break,
                }
            }
        }
        // Last-handle drop is also graceful: no invocation is abandoned at an
        // await point by a disappearing client/server handle.
        self.stop_actions().await;

        let result = Box::pin(self.database.close())
            .await
            .map_err(|e| Error::Invalid(e.to_string()));
        self.closed.send_replace(Some(result));
    }

    async fn maintain_plugins(&mut self) {
        let names: Vec<_> = self
            .plugins
            .iter()
            .flat_map(|loaded| loaded.catalog.plugins.iter())
            .filter_map(|(id, plugin)| {
                plugin
                    .manifest
                    .plugin
                    .maintenance
                    .as_ref()
                    .map(|name| format!("{id}/{name}"))
            })
            .collect();
        for name in names {
            match self
                .invoke_function(
                    &name,
                    serde_json::json!({}),
                    true,
                    Some(crate::identity::AuthContext::server()),
                )
                .await
            {
                Err(error) => eprintln!("Plugin maintenance {name}: {error}"),
                Ok(result) if crate::protocol::failure_kind(&result).is_some() => {
                    eprintln!("Plugin maintenance {name} returned a failure");
                }
                Ok(_) => {}
            }
            self.drain_changes();
            self.refresh().await;
        }
    }
}
