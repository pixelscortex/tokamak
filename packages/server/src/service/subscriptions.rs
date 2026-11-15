use super::*;

impl Coordinator {
    pub(super) fn invalidate(&mut self, change: Option<&ChangeEvent>) {
        for client in self.sessions.values_mut() {
            for sub in client.subscriptions.values_mut() {
                if sub.uncertain || change.is_none_or(|change| sub.reads.affected(change)) {
                    sub.dirty = true;
                }
            }
        }
    }

    pub(super) fn drain_changes(&mut self) {
        // Bound time as well as space. A saturated/lagging receiver conservatively
        // invalidates everything; no growing table/event history is retained.
        for _ in 0..256 {
            match self.changes.try_recv() {
                Ok(change) => self.invalidate(Some(&change)),
                Err(broadcast::error::TryRecvError::Lagged(_)) => self.invalidate(None),
                Err(_) => return,
            }
        }
        self.invalidate(None);
    }

    pub(super) async fn refresh(&mut self) {
        // Register before executing, then install the NEW readset before draining
        // events accumulated during that run. This includes initial/empty/get
        // dependencies, so a write to a newly read table cannot be lost.
        let mut reruns = BTreeMap::<(u64, u64), usize>::new();

        loop {
            self.sessions.retain(|_, client| !client.output.is_closed());

            let next = self.sessions.iter().find_map(|(&owner, client)| {
                client
                    .subscriptions
                    .iter()
                    .find(|(_, sub)| sub.dirty)
                    .map(|(&id, sub)| (owner, id, sub.name.clone(), sub.args.clone()))
            });

            let Some((owner, id, name, args)) = next else {
                return;
            };
            self.sessions
                .get_mut(&owner)
                .unwrap()
                .subscriptions
                .get_mut(&id)
                .unwrap()
                .dirty = false;

            let call = if self.kinds.get(&name) == Some(&FunctionKind::Query) {
                host::invoke(
                    &self.database,
                    &self.pool,
                    self.bundle.clone(),
                    &name,
                    args,
                    false,
                    &self.space,
                    self.plugins.clone(),
                    engine::Determinism::default(),
                )
                .await
            } else {
                host::Call {
                    result: Err(
                        "Subscription query is not registered in this plugin generation".into(),
                    ),
                    reads: ReadSet::new(),
                    conflict: false,
                }
            };

            let sub = self
                .sessions
                .get_mut(&owner)
                .unwrap()
                .subscriptions
                .get_mut(&id)
                .unwrap();
            sub.reads = call.reads;
            sub.uncertain = call.result.is_err();
            self.drain_changes();

            let sub = self
                .sessions
                .get_mut(&owner)
                .unwrap()
                .subscriptions
                .get_mut(&id)
                .unwrap();

            if sub.dirty {
                let count = reruns.entry((owner, id)).or_default();
                *count += 1;

                if *count < 4 {
                    continue;
                }
                // Native transactions retained outside the service can keep
                // changing snapshots. End explicitly instead of publishing a
                // known-stale value or starving every command indefinitely.
                self.sessions
                    .get_mut(&owner)
                    .unwrap()
                    .subscriptions
                    .remove(&id);
                self.emit(
                    owner,
                    Event::Subscription {
                        id,
                        result: Err("subscription ended: snapshot kept changing".into()),
                    },
                );
                continue;
            }

            if sub.last.as_ref() != Some(&call.result) {
                sub.last = Some(call.result.clone()); // serde_json structural equality; no hash dependency.
                self.emit(
                    owner,
                    Event::Subscription {
                        id,
                        result: call.result,
                    },
                );
            }
        }
    }

    pub(super) async fn subscribe(&mut self, session: u64, id: u64, name: String, args: Json) {
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
            self.respond(session, id, Err(error.into()));
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
}
