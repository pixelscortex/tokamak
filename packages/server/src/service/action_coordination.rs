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
        let target = self
            .plugins
            .as_ref()
            .and_then(|loaded| loaded.targets.get(&name));
        let mut note = match target {
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
        if let crate::actions::Destination::Failed(error) = destination {
            self.respond(session, id, Ok(placement.response(error.value())));
            return;
        }
        let owner = target.map(|target| (target.local_name.clone(), target.owner.clone()));
        if let Some(reply) = self.window_action_reply(session, id, &name, &destination, &mut note) {
            self.respond(session, id, reply);
            return;
        }

        let attached = matches!(
            destination,
            crate::actions::Destination::AttachedRunner { .. }
        );
        let output = match self.action_session(session, attached) {
            Ok(output) => output,
            Err(error) => {
                self.respond(session, id, Err(error.into()));
                return;
            }
        };
        let process = match self.action_process() {
            Ok(process) => process.clone(),
            Err(error) => {
                self.respond(session, id, Err(error.into()));
                return;
            }
        };
        let (local_name, owner) =
            owner.map_or_else(|| (name, None), |(local, owner)| (local, Some(owner)));
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
        let invocation = async move {
            destination
                .invoke(&process, source, local_name, args, ops)
                .await
                .map(|value| placement.response(value))
                .map_err(|error| error.map_text(|text| environment.redact(text)))
        };
        self.spawn_action_job(session, id, output, invocation);
    }

    fn window_action_reply(
        &mut self,
        session: u64,
        id: u64,
        name: &str,
        destination: &crate::actions::Destination,
        note: &mut CallNote,
    ) -> Option<Result<Json, String>> {
        match self.prepare_hook_scope(session, id, destination, note) {
            Ok(owns) => destination
                .immediate_reply(note, self.plugins.as_deref(), name, owns)
                .map(Ok),
            Err(error) => Some(Err(error.into())),
        }
    }

    fn prepare_hook_scope(
        &mut self,
        session: u64,
        id: u64,
        destination: &crate::actions::Destination,
        note: &mut CallNote,
    ) -> Result<bool, &'static str> {
        if !matches!(
            destination,
            crate::actions::Destination::CallerWindowRunner { .. }
        ) || note.hook_scope.is_some()
            || self
                .plugins
                .as_ref()
                .is_none_or(|plugins| plugins.hooks.is_empty())
        {
            return Ok(false);
        }

        let client = self.sessions.get_mut(&session).ok_or("Session closed")?;
        if client.hook_scopes.len() >= 1024 || client.hook_scopes.contains_key(&id) {
            return Err("Window action hook capacity exceeded");
        }

        let budget = crate::identity::HookBudget::default();
        client.hook_scopes.insert(id, budget.clone());
        note.scope_hooks(id, budget);
        Ok(true)
    }

    fn spawn_action_job(
        &mut self,
        session: u64,
        id: u64,
        output: Option<mpsc::Sender<Event>>,
        invocation: impl std::future::Future<Output = Result<Json, CallError>> + Send + 'static,
    ) {
        if self.action_cancellations.contains_key(&(session, id)) {
            self.respond(session, id, Err("Duplicate action request ID".into()));
            return;
        }
        let cancel = tokio_util::sync::CancellationToken::new();
        self.action_cancellations
            .insert((session, id), (cancel.clone(), output.is_some()));
        self.action_jobs
            .spawn(async move { (session, id, action_job(cancel, output, invocation).await) });
    }

    fn action_session(
        &self,
        session: u64,
        attached: bool,
    ) -> Result<Option<mpsc::Sender<Event>>, &'static str> {
        if attached {
            return self
                .sessions
                .get(&session)
                .map(|client| Some(client.output.clone()))
                .ok_or("Action cancelled");
        }
        if self
            .action_cancellations
            .values()
            .filter(|(_, attached)| !attached)
            .count()
            >= ACTIONS
        {
            return Err("action capacity exceeded");
        }
        Ok(None)
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
                self.respond_call(session, id, result);
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

async fn action_job(
    cancel: tokio_util::sync::CancellationToken,
    output: Option<mpsc::Sender<Event>>,
    invocation: impl std::future::Future<Output = Result<Json, CallError>>,
) -> Result<Json, CallError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err("Action cancelled".into()),
        () = async {
            match &output {
                Some(output) => output.closed().await,
                None => std::future::pending().await,
            }
        } => Err("Action cancelled".into()),
        result = invocation => result,
    }
}
