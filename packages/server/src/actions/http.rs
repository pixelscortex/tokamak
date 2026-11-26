//! Admission for the ordinary functions called by one HTTP handler.
use super::*;
use crate::environment::Snapshot;

pub(crate) struct HttpCalls {
    pub generation: Arc<Loaded>,
    pub owner: Arc<str>,
    pub commands: mpsc::WeakSender<Command>,
    pub runner: Arc<Machines>,
    pub process: Option<Arc<Supervisor>>,
}

impl HttpCalls {
    pub(crate) fn operations(
        self,
        environment: Arc<Snapshot>,
        lifetime: CancellationToken,
    ) -> Result<OpRegistry, engine::Error> {
        let mut ops = OpRegistry::new();
        environment.register_env(&mut ops)?;
        let calls = Arc::new(self);
        ops.register_call("plugin.call", move |payload| {
            let calls = calls.clone();
            let environment = environment.clone();
            let lifetime = lifetime.clone();
            async move {
                calls.call(payload, lifetime).await.map_err(|error| {
                    CallError::from(error)
                        .map_text(|text| environment.redact(text))
                        .into()
                })
            }
        })?;
        Ok(ops)
    }

    async fn call(
        &self,
        payload: Json,
        lifetime: CancellationToken,
    ) -> Result<Json, engine::CallError> {
        let name = payload["name"]
            .as_str()
            .ok_or("HTTP action call requires a function name")?;
        let args = payload
            .get("args")
            .ok_or("HTTP action call requires args")?
            .clone();
        let target = self.generation.action_target(&self.owner, name, None)?;
        if target.owner.as_str() != &*self.owner {
            return Err("HTTP actions can only call functions in their own plugin".into());
        }
        target.kind.check_requested(&payload)?;
        let note = CallNote::default()
            .with_root_args(&target.args, &args)
            .for_http(self.owner.clone());
        let owner = self.owner.to_string();
        if target.kind != FunctionKind::Action {
            let (reply, wait) = oneshot::channel();
            return NestedCall::send(
                &self.commands,
                NestedCall {
                    http_root: true,
                    note,
                    generation: Some(self.generation.clone()),
                    lifetime: Some(lifetime),
                    owner: Some(owner),
                    name: name.into(),
                    args,
                    kind: target.kind,
                    contract: None,
                    reply,
                },
                wait,
            )
            .await
            .map_err(Into::into);
        }

        let loaded = current_plugins(&self.commands, &lifetime).await?;
        if !Arc::ptr_eq(&loaded, &self.generation)
            && !loaded.same_plugin(&self.generation, &self.owner)
        {
            return Err("HTTP action belongs to a retired plugin generation".into());
        }
        let target = loaded.action_target(&self.owner, name, None)?;
        let process = self.process.clone().ok_or("Action process unavailable")?;
        run_nested_action(
            loaded,
            target,
            self.commands.clone(),
            process,
            ActionContext {
                note,
                runner: self.runner.clone(),
                lifetime: None,
                qualified: None,
                dispatch: None,
            },
            args,
            (owner, requested_placement(&payload)?),
        )
        .await
    }
}
