use super::*;

impl Coordinator {
    fn action_execution(&self) -> crate::actions::Execution {
        crate::actions::Execution {
            limits: self
                .action_pool
                .as_ref()
                .unwrap_or(&self.pool)
                .limits()
                .clone(),
            process: self.action_process.clone(),
        }
    }

    pub(super) fn start_action(
        &mut self,
        session: u64,
        auth: crate::identity::AuthContext,
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
            self.action_execution(),
            vec![name.clone()],
            Some(auth),
        ) {
            Ok(ops) => ops,
            Err(error) => {
                self.respond(session, id, Err(environment.redact(error.to_string())));
                return;
            }
        };
        if let Some(process) = &self.action_process {
            let source = match (&self.plugins, &owner) {
                (Some(loaded), Some(owner)) => loaded.action_sources.get(owner).cloned(),
                _ => self.legacy_action_source.clone(),
            };
            let Some(source) = source else {
                self.respond(
                    session,
                    id,
                    Err("Plugin action has no action process bundle".into()),
                );
                return;
            };
            let process = process.clone();
            self.action_jobs.spawn(async move {
                (
                    session,
                    id,
                    process
                        .invoke(source, local_name, args, ops)
                        .await
                        .map_err(|error| environment.redact(error)),
                )
            });
            return;
        }

        self.start_in_process_or_bun(
            session,
            id,
            bundle,
            local_name,
            #[cfg(feature = "local-runtime")]
            owner.as_deref(),
            args,
            ops,
            environment,
        );
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Dispatch uses the already prepared invocation snapshot"
    )]
    fn start_in_process_or_bun(
        &mut self,
        session: u64,
        id: u64,
        bundle: Arc<Bundle>,
        local_name: String,
        #[cfg(feature = "local-runtime")] owner: Option<&str>,
        args: Json,
        ops: Arc<engine::OpRegistry>,
        environment: Arc<crate::environment::Snapshot>,
    ) {
        #[cfg(feature = "local-runtime")]
        let worker = self
            .plugins
            .as_ref()
            .and_then(|p| owner.and_then(|owner| p.workers.get(owner)))
            .cloned();
        #[cfg(feature = "local-runtime")]
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
        let pool = self.action_pool.as_ref().expect("in-process action lane");
        match pool.submit(
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
        if let Some(pool) = &self.action_pool {
            pool.cancel_actions();
        }
        if let Some(process) = &self.action_process {
            process.stop().await;
        }

        #[cfg(feature = "local-runtime")]
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
                        call.auth.clone(),
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
        let actual = match (&self.plugins, &call.generation, &call.owner) {
            (Some(current), Some(generation), Some(owner))
                if Arc::ptr_eq(current, generation)
                    || (self.action_process.is_some()
                        && current.same_action_source(generation, owner)) =>
            {
                let target = current.target(
                    owner,
                    &call.name,
                    call.kind == FunctionKind::Mutation,
                    &[],
                    call.contract.as_deref(),
                )?;

                if !Arc::ptr_eq(current, generation)
                    && !current.same_plugin(generation, &target.owner)
                {
                    return Err(
                        "nested action target belongs to a retired plugin generation".into(),
                    );
                }

                if call.auth.is_none() {
                    target.check_anonymous_scope(owner)?;
                }
                Some(target.kind)
            }
            (None, None, None) => self.kinds.get(&call.name).copied(),
            _ => return Err("action belongs to a retired plugin generation".to_owned()),
        };
        call.kind.check_nested(actual)
    }
}
