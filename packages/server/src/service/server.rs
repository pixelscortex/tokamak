use super::*;

impl Server {
    pub fn descriptor(&self) -> &Json {
        &self.descriptor
    }

    /// Ordered live metadata. descriptor() remains the legacy startup snapshot.
    pub async fn plugins(&self) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Plugins(reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    /// Swaps changed builds and retries plugins that were skipped.
    pub async fn reload_plugin(&self, id: String) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Reload(id, reply))?;
        let (metadata, logs) = wait.await.map_err(|_| Error::Closed)??;
        for log in logs {
            log.published().await;
        }
        Ok(metadata)
    }

    pub(crate) async fn window_error(
        &self,
        id: String,
        revision: String,
        text: String,
    ) -> Result<bool, Error> {
        let (reply, wait) = oneshot::channel();
        admit(
            &self.commands,
            Command::WindowError(id, revision, text, reply),
        )?;
        wait.await.map_err(|_| Error::Closed)?
    }

    pub(crate) async fn upload_package(
        &self,
        upload: crate::plugins::package::Upload,
    ) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::UploadPackage(upload, reply))?;
        let (response, logs) = wait.await.map_err(|_| Error::Closed)??;
        for log in logs {
            log.published().await;
        }
        Ok(response)
    }

    pub(crate) async fn reload_indexed(
        &self,
        request: crate::plugins::IndexedReload,
    ) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::ReloadIndexed(request, reply))?;
        let (metadata, logs) = wait.await.map_err(|_| Error::Closed)??;
        for log in logs {
            log.published().await;
        }
        Ok(metadata)
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
        self.connect_as(crate::identity::User::local()).await
    }

    pub async fn rename_user(&self, user: crate::identity::User) -> Result<(), Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::RenameUser(user, reply))?;
        wait.await.map_err(|_| Error::Closed)
    }

    pub async fn connect_as(&self, user: crate::identity::User) -> Result<Session, Error> {
        let user = Arc::new(std::sync::RwLock::new(user));
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Connect(user.clone(), reply))?;

        let (id, output, slow, alive) = wait.await.map_err(|_| Error::Closed)??;

        Ok(Session {
            sender: SessionSender {
                id,
                user,
                commands: self.commands.clone(),
                slow,
                alive,
                wait_for_capacity: false,
            },
            output,
            cleanup: self.cleanup.clone(),
        })
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
