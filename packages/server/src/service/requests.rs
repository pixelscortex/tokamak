use super::action_coordination::ActionCall;
use super::*;
use crate::{
    actions::Placement,
    identity::{AuthContext, CallNote},
};

struct RequestCaller {
    auth: AuthContext,
    note: CallNote,
    placement: Placement,
}

impl Coordinator {
    pub(super) async fn action(&mut self, session: u64, auth: SessionAuth, action: Action) {
        // Admission transfers call ownership to the coordinator. Disconnect
        // retires subscriptions and delivery, not accepted mutations waiting in
        // the command queue. Shutdown must drain those calls too.
        if !self.sessions.contains_key(&session) && !matches!(&action, Action::Call { .. }) {
            return;
        }

        match action {
            Action::Cancel(id) => {
                if let Some((cancel, _)) = self.action_cancellations.get(&(session, id)) {
                    cancel.cancel();
                }
            }

            Action::Plugins(id) => {
                let result = self.catalog_page(None, 0);
                self.respond(session, id, result);
            }
            Action::PluginsPage {
                id,
                revision,
                offset,
            } => {
                let result = self.catalog_page(Some(&revision), offset);
                self.respond(session, id, result);
            }
            Action::PluginAsset {
                id,
                plugin,
                name,
                revision,
                offset,
            } => {
                self.asset_page(session, id, plugin, name, revision, offset);
            }
            Action::Call {
                id,
                name,
                args,
                kind: expected,
                local_parent,
                placement,
            } => match self.request_caller(auth, &name, &args, local_parent, placement) {
                Ok(caller) => self.call(session, id, name, args, expected, caller).await,
                Err(error) => self.respond(session, id, Err(error)),
            },
            Action::Subscribe { id, name, args } => {
                self.subscribe(session, id, name, args).await;
            }
            Action::Unsubscribe(id) => {
                self.sessions
                    .get_mut(&session)
                    .expect("checked session")
                    .subscriptions
                    .remove(&id);
                self.emit(session, Event::Unsubscribed { id });
            }
        }
    }

    fn request_caller(
        &self,
        session: SessionAuth,
        name: &str,
        args: &Json,
        local_parent: Option<(usize, Option<String>)>,
        placement: Placement,
    ) -> Result<RequestCaller, String> {
        // A socket may already have admitted a write when its member
        // was revoked. It must not recreate rows after cleanup.
        if name == window_state::WRITE && session.revoked.is_cancelled() {
            return Err("Session has been revoked".into());
        }
        let auth = session.caller.read().expect("auth lock").clone();
        let note = if let Some((depth, thread)) = local_parent {
            let validator = self
                .plugins
                .as_ref()
                .and_then(|loaded| loaded.targets.get(name))
                .map(|target| target.args.as_ref());
            CallNote::from_local_parent(&auth, depth, thread)?
                .enter(name, validator, args)
                .map_err(|error| error.to_string())?
        } else {
            Some(auth.clone()).into()
        };
        Ok(RequestCaller {
            auth,
            note,
            placement,
        })
    }

    async fn call(
        &mut self,
        session: u64,
        id: u64,
        name: String,
        args: Json,
        expected: Option<FunctionKind>,
        RequestCaller {
            auth,
            note,
            placement,
        }: RequestCaller,
    ) {
        if let Some(query) = builtin_queries::resolve(&name, &args) {
            let result = if expected.is_none_or(|kind| kind == FunctionKind::Query) {
                query.map(|read| read(&auth)).map_err(str::to_owned)
            } else {
                Err("auth caller identity requires a query".into())
            };
            self.respond(session, id, result);
            return;
        }
        if name == "tokamak:whoami" {
            let result = if expected.is_none_or(|kind| kind == FunctionKind::Query)
                && args == serde_json::json!({})
            {
                Ok(serde_json::json!(auth.user))
            } else {
                Err("whoami requires a query with empty arguments".into())
            };
            self.respond(session, id, result);
            return;
        }
        if matches!(name.as_str(), window_state::READ | window_state::WRITE) {
            // Keep the database transaction future off the coordinator's stack.
            let result = Box::pin(window_state::call(
                &self.database,
                self.plugins.as_ref().map(|loaded| &loaded.catalog),
                &auth.user.id,
                &name,
                expected,
                args,
            ))
            .await;
            self.respond(session, id, result);
            return;
        }
        let result = match self.client_kind(&name) {
            None => Err(format!("unknown function: {name}").into()),
            Some(kind) if expected.is_some_and(|expected| expected != kind) => {
                Err("function kind does not match request".into())
            }
            Some(FunctionKind::Action) => {
                self.start_action(session, id, name, args, ActionCall { note, placement });
                return;
            }
            Some(kind) => {
                self.invoke_function_in(
                    self.plugins.clone(),
                    &name,
                    args,
                    kind == FunctionKind::Mutation,
                    note,
                )
                .await
            }
        };
        self.drain_changes();
        self.refresh().await; // Writer barrier precedes response on the SAME queue.
        self.respond_call(session, id, result);
    }
}
