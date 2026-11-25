use super::*;

impl Coordinator {
    pub(super) fn start_action(
        &mut self,
        session: u64,
        note: crate::identity::CallNote,
        id: u64,
        name: String,
        args: Json,
    ) {
        if self.action_jobs.len() >= ACTIONS {
            self.respond(session, id, Err("action capacity exceeded".into()));
            return;
        }

        let process = match self.action_process() {
            Ok(process) => process.clone(),
            Err(error) => {
                self.respond(session, id, Err(error.into()));
                return;
            }
        };
        let (local_name, owner) = if let Some(loaded) = &self.plugins {
            let target = &loaded.targets[&name];
            (target.local_name.clone(), Some(target.owner.clone()))
        } else {
            (name.clone(), None)
        };
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

        let environment = Arc::new(crate::environment::Snapshot::new(
            self.plugins.as_deref(),
            owner.as_deref(),
        ));
        let note = match &self.plugins {
            Some(loaded) => {
                let target = &loaded.targets[&name];
                note.with_args(&target.args, &args)
            }
            None => note,
        };
        let ops = match crate::actions::operations(
            self.commands.clone(),
            self.plugins.clone(),
            owner.clone(),
            environment.clone(),
            process.clone(),
            note,
        ) {
            Ok(ops) => ops,
            Err(error) => {
                self.respond(session, id, Err(environment.redact(error.to_string())));
                return;
            }
        };
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
    }

    pub(super) fn action_process(
        &self,
    ) -> Result<&Arc<crate::host::action_process::Supervisor>, &'static str> {
        tokamak_worker::require_plugin_platform(std::env::consts::OS)?;
        self.action_process
            .as_ref()
            .ok_or("Action process unavailable")
    }

    pub(super) async fn stop_actions(&mut self) {
        if let Some(process) = &self.action_process {
            process.stop().await;
        }

        while let Some(completion) = self.action_jobs.join_next().await {
            if let Ok((session, id, result)) = completion {
                self.respond(session, id, result);
            }
        }
    }

    pub(super) async fn run_function(&mut self, call: crate::actions::NestedCall) {
        let result = match self
            .validate_nested(&call)
            .and_then(|()| call.note.clone().nested(&call.name))
        {
            Err(error) => Err(error),
            Ok(note) => {
                let result = self
                    .invoke_function_in(
                        self.plugins.clone(),
                        &call.name,
                        call.args.clone(),
                        call.kind == FunctionKind::Mutation,
                        note,
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
                    || current.same_action_source(generation, owner) =>
            {
                let target = current.target(
                    owner,
                    &call.name,
                    call.kind == FunctionKind::Mutation,
                    call.contract.as_deref(),
                )?;

                if !Arc::ptr_eq(current, generation)
                    && !current.same_plugin(generation, &target.owner)
                {
                    return Err(
                        "nested action target belongs to a retired plugin generation".into(),
                    );
                }

                if call.note.auth.is_none() {
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
