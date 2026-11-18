use super::*;

impl Coordinator {
    pub(super) fn start_action(
        &mut self,
        session: u64,
        user: crate::identity::User,
        id: u64,
        name: String,
        args: Json,
    ) {
        if self.action_jobs.len() >= ACTIONS {
            self.respond(session, id, Err("action capacity exceeded".into()));
            return;
        }

        let (bundle, local_name, owner) = if let Some(loaded) = &self.plugins {
            let target = &loaded.targets[&name];
            (
                target.bundle.clone(),
                target.local_name.clone(),
                Some(target.owner.clone()),
            )
        } else {
            (
                self.bundle.clone().expect("legacy bundle"),
                name.clone(),
                None,
            )
        };

        let environment = Arc::new(crate::environment::Snapshot::new(
            self.plugins.as_deref(),
            owner.as_deref(),
        ));
        let ops = match crate::actions::operations(
            self.commands.clone(),
            self.plugins.clone(),
            owner.clone(),
            environment.clone(),
            self.action_pool.limits().clone(),
            vec![name.clone()],
            user,
        ) {
            Ok(ops) => ops,
            Err(error) => {
                self.respond(session, id, Err(environment.redact(error.to_string())));
                return;
            }
        };
        let worker = self
            .plugins
            .as_ref()
            .and_then(|p| owner.as_ref().and_then(|owner| p.workers.get(owner)))
            .cloned();
        if let Some(worker) = worker {
            self.action_jobs.spawn(async move {
                (
                    session,
                    id,
                    worker
                        .invoke(local_name, args, ops)
                        .await
                        .map_err(|e| environment.redact(e)),
                )
            });
            return;
        }
        match self.action_pool.submit(
            bundle,
            "invoke",
            serde_json::json!({"name":local_name,"args":args}),
            ops,
        ) {
            Ok(pending) => {
                self.action_jobs.spawn(async move {
                    (
                        session,
                        id,
                        pending.await.map_err(|e| environment.redact(e.to_string())),
                    )
                });
            }
            Err(error) => self.respond(session, id, Err(environment.redact(error.to_string()))),
        }
    }

    pub(super) async fn stop_actions(&mut self) {
        self.action_pool.cancel_actions();
        if let Some(loaded) = &self.plugins {
            for worker in loaded.workers.values() {
                worker.stop().await;
            }
        }

        while let Some(completion) = self.action_jobs.join_next().await {
            if let Ok((session, id, result)) = completion {
                self.respond(session, id, result);
            }
        }
    }

    pub(super) async fn run_function(&mut self, call: crate::actions::NestedCall) {
        let result = match self.validate_nested(&call) {
            Err(error) => Err(error),
            Ok(()) => {
                let result = self
                    .invoke_function(
                        &call.name,
                        call.args.clone(),
                        call.kind == FunctionKind::Mutation,
                        call.user.clone(),
                    )
                    .await;
                self.drain_changes();
                self.refresh().await;
                result
            }
        };

        let _ = call.reply.send(result);
    }

    fn validate_nested(&self, call: &crate::actions::NestedCall) -> Result<(), String> {
        match (&self.plugins, &call.generation, &call.owner) {
            (Some(current), Some(generation), Some(owner)) if Arc::ptr_eq(current, generation) => {
                let target =
                    current.target(owner, &call.name, call.kind == FunctionKind::Mutation, &[])?;

                if target.kind != call.kind {
                    return Err("nested function kind does not match request".to_owned());
                }
            }
            (None, None, None) => {
                if self.kinds.get(&call.name) != Some(&call.kind) {
                    return Err("nested function kind does not match request".to_owned());
                }
            }
            _ => return Err("action belongs to a retired plugin generation".to_owned()),
        }

        Ok(())
    }
}
