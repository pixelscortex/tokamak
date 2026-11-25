use super::*;
use crate::actions::{ActionContext, Placement, resolve};
use crate::identity::CallNote;

pub(super) struct ActionCall {
    pub note: CallNote,
    pub placement: Placement,
}

impl Coordinator {
    pub(super) fn start_action(
        &mut self,
        session: u64,
        id: u64,
        name: String,
        args: Json,
        ActionCall { note, placement }: ActionCall,
    ) {
        if self.action_jobs.len() >= ACTIONS {
            self.respond(session, id, Err("action capacity exceeded".into()));
            return;
        }

        let target = self
            .plugins
            .as_ref()
            .and_then(|loaded| loaded.targets.get(&name));
        let note = match target {
            Some(target) => note.with_root_args(&target.args, &args),
            None => note,
        };
        let destination = resolve(
            self.plugins.as_deref(),
            target,
            placement,
            &self.runner,
            &note,
        );
        if let Some(reply) = destination.immediate_reply(placement, &note) {
            self.respond(session, id, Ok(reply));
            return;
        }

        let process = match self.action_process() {
            Ok(process) => process.clone(),
            Err(error) => {
                self.respond(session, id, Err(error.into()));
                return;
            }
        };
        let (local_name, owner) = target.map_or_else(
            || (name, None),
            |target| (target.local_name.clone(), Some(target.owner.clone())),
        );
        let source = match (&self.plugins, &owner) {
            (Some(loaded), Some(owner)) => loaded.action_sources.get(owner).cloned(),
            _ => self.legacy_action_source.clone(),
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
            process.clone(),
            ActionContext {
                note,
                runner: self.runner.clone(),
            },
        ) {
            Ok(ops) => ops,
            Err(error) => {
                self.respond(session, id, Err(environment.redact(error.to_string())));
                return;
            }
        };
        if self.action_cancellations.contains_key(&(session, id)) {
            self.respond(session, id, Err("Duplicate action request ID".into()));
            return;
        }
        let cancel = tokio_util::sync::CancellationToken::new();
        self.action_cancellations
            .insert((session, id), cancel.clone());
        self.action_jobs.spawn(async move {
            let result = tokio::select! {
                biased;
                () = cancel.cancelled() => Err("Action cancelled".into()),
                result = destination.invoke(&process, source, local_name, args, ops) => result,
            };

            (
                session,
                id,
                result
                    .map(|value| placement.response(value))
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
        let result = match self.enter_nested(&call) {
            Err(error) => Err(error.into()),
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

    fn enter_nested(
        &self,
        call: &crate::actions::NestedCall,
    ) -> Result<crate::identity::CallNote, String> {
        let (kind, validator) = match (&self.plugins, &call.generation, &call.owner) {
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
                (Some(target.kind), Some(target.args))
            }
            (None, None, None) => (self.kinds.get(&call.name).copied(), None),
            _ => return Err("action belongs to a retired plugin generation".to_owned()),
        };
        call.kind.check_nested(kind)?;
        call.note
            .enter(&call.name, validator.as_deref(), &call.args)
            .map_err(|error| error.to_string())
    }
}
