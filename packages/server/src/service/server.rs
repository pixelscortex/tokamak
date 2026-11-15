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
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Asset(id, name, reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    pub fn functions(&self) -> &[Json] {
        self.descriptor["functions"].as_array().expect("validated descriptor")
    }

    pub async fn connect(&self) -> Result<Session, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Connect(reply))?;

        let (id, output, slow, alive) = wait.await.map_err(|_| Error::Closed)??;

        Ok(Session {
            sender: SessionSender {
                id,
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
