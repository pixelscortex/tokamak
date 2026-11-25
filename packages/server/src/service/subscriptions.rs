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

    fn subscription(&mut self, owner: u64, id: u64) -> &mut Subscription {
        self.sessions
            .get_mut(&owner)
            .unwrap()
            .subscriptions
            .get_mut(&id)
            .unwrap()
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
                    .map(|(&id, sub)| (owner, id, sub.query.clone()))
            });

            let Some((owner, id, query)) = next else {
                return;
            };
            self.subscription(owner, id).dirty = false;

            let call = self.run_subscription(owner, query).await;

            let sub = self.subscription(owner, id);
            sub.reads = call.reads;
            sub.uncertain = call.result.is_err();
            self.drain_changes();

            let sub = self.subscription(owner, id);

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
        let kind = self.client_kind(&name);
        let client = self.sessions.get_mut(&session).expect("checked session");

        let query = match builtin_queries::resolve(&name, &args) {
            Some(resolved) => resolved.map(SubscriptionQuery::Builtin),
            None if kind == Some(FunctionKind::Query) => {
                Ok(SubscriptionQuery::Plugin { name, args })
            }
            None => Err("subscriptions require a registered query"),
        };
        let query = match query.and_then(|query| {
            if client.subscriptions.contains_key(&id) {
                Err("subscription ID already in use")
            } else if client.subscriptions.len() >= SUBSCRIPTIONS {
                Err("subscription capacity exceeded")
            } else {
                Ok(query)
            }
        }) {
            Ok(query) => query,
            Err(error) => {
                // Invalid registration never replaces an existing subscription.
                self.respond(session, id, Err(error.into()));
                return;
            }
        };
        client.subscriptions.insert(
            id,
            Subscription {
                query,
                reads: ReadSet::new(),
                last: None,
                dirty: true,
                uncertain: true,
            },
        );
        self.drain_changes();
        self.refresh().await;
    }
    async fn run_subscription(&self, owner: u64, query: SubscriptionQuery) -> host::Call {
        let auth = self.sessions[&owner]
            .auth
            .caller
            .read()
            .expect("auth lock")
            .clone();
        match query {
            SubscriptionQuery::Builtin(read) => host::Call {
                result: Ok(read(&auth)),
                reads: ReadSet::new(),
                conflict: false,
            },
            SubscriptionQuery::Plugin { name, args }
                if self.client_kind(&name) == Some(FunctionKind::Query) =>
            {
                host::invoke(
                    &self.database,
                    &self.pool,
                    host::Invocation {
                        bundle: self.bundle.clone(),
                        name: &name,
                        args,
                        mutation: false,
                        space: &self.space,
                        plugins: self.plugins.clone(),
                        determinism: engine::Determinism::default(),
                        note: Some(auth).into(),
                    },
                )
                .await
            }
            SubscriptionQuery::Plugin { .. } => host::Call {
                result: Err(
                    "Subscription query is not registered in this plugin generation".into(),
                ),
                reads: ReadSet::new(),
                conflict: false,
            },
        }
    }
}
