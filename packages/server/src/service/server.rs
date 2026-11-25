use super::*;

impl Server {
    /// Attach the Runner that embeds this server before accepting workspace calls.
    pub fn attach_runner(
        &self,
        dispatch: impl Fn(crate::RunnerAction) -> crate::RunnerFuture + Send + Sync + 'static,
    ) -> Result<(), Error> {
        if self.runner.attach(Arc::new(dispatch)) {
            Ok(())
        } else {
            Err(Error::Invalid("Runner already attached".into()))
        }
    }

    pub(crate) fn machines(&self) -> &crate::actions::Machines {
        &self.runner
    }

    pub fn descriptor(&self) -> &Json {
        &self.descriptor
    }

    /// Ordered live metadata. descriptor() remains the legacy startup snapshot.
    pub async fn plugins(&self) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Plugins(reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    /// Core-only discovery for sign-in before a session exists. No request
    /// or session command exposes provider actions to windows.
    pub async fn sign_in_methods(&self) -> Result<Vec<crate::plugins::SignInMethod>, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::SignInMethods(reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    /// Replaces the complete installation generation, including dependent callers.
    pub async fn reload_plugin(&self, id: String) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Reload(id, reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    pub async fn plugin_asset(
        &self,
        id: String,
        name: String,
    ) -> Result<Option<Arc<crate::plugins::Asset>>, Error> {
        self.plugin_asset_at(id, name, None).await
    }

    pub async fn plugin_asset_at(
        &self,
        id: String,
        name: String,
        revision: Option<String>,
    ) -> Result<Option<Arc<crate::plugins::Asset>>, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Asset(revision, id, name, reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    pub fn functions(&self) -> &[Json] {
        self.descriptor["functions"]
            .as_array()
            .expect("validated descriptor")
    }

    pub async fn connect(&self) -> Result<Session, Error> {
        self.connect_authenticated(
            crate::identity::AuthContext::local(),
            Default::default(),
            true,
        )
        .await
    }

    pub(crate) async fn update_user(
        &self,
        save: impl FnOnce() -> Result<crate::identity::User, String>,
    ) -> Result<crate::identity::User, String> {
        // Reserve notification capacity before persisting. An overloaded or
        // cancelled requester cannot leave connected clients on a stale role.
        let permit = self
            .commands
            .reserve()
            .await
            .map_err(|_| Error::Closed.to_string())?;
        let user = save()?;
        let (reply, wait) = oneshot::channel();
        permit.send(Command::UpdateUser(user.clone(), reply));
        wait.await.map_err(|_| Error::Closed.to_string())?;
        Ok(user)
    }

    pub async fn connect_as(&self, user: crate::identity::User) -> Result<Session, Error> {
        self.connect_authenticated(
            crate::identity::AuthContext::in_process(user),
            Default::default(),
            true,
        )
        .await
    }

    pub(crate) async fn connect_authenticated(
        &self,
        auth: crate::identity::AuthContext,
        revoked: tokio_util::sync::CancellationToken,
        local_continuations: bool,
    ) -> Result<Session, Error> {
        let auth = Arc::new(SessionIdentity {
            caller: std::sync::RwLock::new(auth),
            revoked,
            local_continuations,
            window_notes: Default::default(),
        });
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Connect(auth.clone(), reply))?;

        let (id, output, slow, alive) = wait.await.map_err(|_| Error::Closed)??;

        Ok(Session {
            sender: SessionSender {
                id,
                auth,
                commands: self.commands.clone(),
                slow,
                alive,
                wait_for_capacity: false,
            },
            output,
            cleanup: self.cleanup.clone(),
        })
    }

    pub(crate) async fn revoke_member(
        &self,
        identities: &crate::identity::Identities,
        id: String,
    ) -> Result<(), String> {
        // Reserve cleanup before revoking access so it still runs if the HTTP
        // caller disconnects after the revocation is saved.
        let permit = self
            .commands
            .reserve()
            .await
            .map_err(|_| Error::Closed.to_string())?;
        let removed = identities.remove_member(&id)?;
        let (reply, wait) = oneshot::channel();
        permit.send(Command::MemberRemoved {
            id,
            user: removed,
            reply,
        });
        wait.await.map_err(|_| Error::Closed.to_string())?
    }

    pub(crate) async fn clear_revoked_window_state(
        &self,
        identities: &crate::identity::Identities,
    ) -> Result<(), String> {
        let ids = identities.revoked_member_ids();
        if ids.is_empty() {
            return Ok(());
        }
        let (reply, wait) = oneshot::channel();
        self.commands
            .send(Command::RemoveUserWindowState(ids, reply))
            .await
            .map_err(|_| Error::Closed.to_string())?;
        wait.await.map_err(|_| Error::Closed.to_string())?
    }

    /// Ordered behind accepted commands; shields shutdown even if this await is
    /// cancelled. Busy (a native transaction still retained externally) keeps
    /// the service live so callers can finish that transaction and retry close.
    pub async fn close(&self) -> Result<(), Error> {
        if let Some(result) = self.closed.borrow().clone() {
            return result;
        }

        let (reply, wait) = oneshot::channel();
        // The first request enters a dedicated one-slot control lane even when
        // application admission is saturated. Once enqueued, cancellation cannot
        // retract it. Concurrent close callers wait for control-lane capacity or
        // the retained outcome; they cannot grow an unbounded shutdown queue.
        if self.closing.send(reply).await.is_err() {
            return self.await_closed().await;
        }

        match wait.await {
            Ok(result) => result,
            Err(_) => self.await_closed().await,
        }
    }

    async fn await_closed(&self) -> Result<(), Error> {
        // A cancelled close caller does not own the shutdown barrier. Retain its
        // completed outcome so retries cannot report Closed before locks release.
        let mut closed = self.closed.clone();

        loop {
            if let Some(result) = closed.borrow_and_update().clone() {
                return result;
            }
            closed.changed().await.map_err(|_| Error::Closed)?;
        }
    }
}
