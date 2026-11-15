use super::*;

impl SessionSender {
    /// Opt this Tower handle into awaitable capacity. Native owners that have
    /// already accepted messages into a bounded local mailbox use this mode
    /// while independently draining output. Headless peers retain fail-fast
    /// overload/disconnection semantics by default.
    pub fn with_backpressure(mut self) -> Self {
        self.wait_for_capacity = true;
        self
    }

    /// Success means admitted, NOT committed. Read replies from recv in order.
    /// Losing the stream after admission means the mutation outcome is unknown;
    /// never blindly retry it. There is no cross-client deduplication protocol.
    pub fn call(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.send(Action::Call {
            id,
            name: name.into(),
            args,
            kind: None,
        })
    }

    /// Common admission path for both adapters. Kind validation happens inside
    /// the ordered coordinator, so an invalid query cannot execute a mutation.
    pub fn request(&self, request: Request) -> Result<(), Error> {
        self.send(request_action(request)?)
    }

    pub fn subscribe(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.send(Action::Subscribe {
            id,
            name: name.into(),
            args,
        })
    }

    pub fn unsubscribe(&self, id: u64) -> Result<(), Error> {
        self.send(Action::Unsubscribe(id))
    }

    fn check_live(&self) -> Result<(), Error> {
        if self.slow.load(Ordering::Acquire) {
            return Err(Error::SlowConsumer);
        }

        if self.alive.upgrade().is_none_or(|sender| sender.is_closed()) {
            return Err(Error::Closed);
        }

        Ok(())
    }

    fn send(&self, action: Action) -> Result<(), Error> {
        self.check_live()?;
        admit(&self.commands, Command::Action(self.id, action))
    }
}

fn request_action(request: Request) -> Result<Action, Error> {
    if request.id() > 9_007_199_254_740_991 {
        return Err(Error::Invalid(
            "request ID must be a JavaScript safe integer".into(),
        ));
    }

    Ok(match request {
        Request::Query { id, name, args } => Action::Call {
            id,
            name,
            args,
            kind: Some(FunctionKind::Query),
        },
        Request::Mutation { id, name, args } => Action::Call {
            id,
            name,
            args,
            kind: Some(FunctionKind::Mutation),
        },
        Request::Action { id, name, args } => Action::Call {
            id,
            name,
            args,
            kind: Some(FunctionKind::Action),
        },
        Request::Subscribe { id, name, args } => Action::Subscribe { id, name, args },
        Request::Unsubscribe { id } => Action::Unsubscribe(id),
        Request::Plugins { id } => Action::Plugins(id),
        Request::PluginsPage {
            id,
            revision,
            offset,
        } => Action::PluginsPage {
            id,
            revision,
            offset,
        },
        Request::PluginAsset {
            id,
            plugin,
            name,
            revision,
            offset,
        } => Action::PluginAsset {
            id,
            plugin,
            name,
            revision,
            offset,
        },
    })
}

/// Tower is the common service boundary, not a second execution path. The
/// response acknowledges bounded admission; application replies use Event only.
/// Backpressured transports must bound pending calls and keep draining output
/// while admission waits. Cancellation before enqueueing never executes a call.
impl tower::Service<Request> for SessionSender {
    type Response = ();
    type Error = Error;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send>>;

    fn poll_ready(&mut self, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let sender = self.clone();
        Box::pin(async move {
            if !sender.wait_for_capacity {
                return sender.request(request);
            }

            let action = request_action(request)?;
            sender.check_live()?;
            // A permit is real bounded backpressure, not a retry of an operation
            // whose commit outcome might already be unknown.
            let permit = sender.commands.reserve().await.map_err(|_| Error::Closed)?;
            sender.check_live()?;
            permit.send(Command::Action(sender.id, action));

            Ok(())
        })
    }
}

impl Session {
    pub fn sender(&self) -> SessionSender {
        self.sender.clone()
    }

    pub fn call(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.sender.call(id, name, args)
    }

    pub fn subscribe(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.sender.subscribe(id, name, args)
    }

    pub fn unsubscribe(&self, id: u64) -> Result<(), Error> {
        self.sender.unsubscribe(id)
    }

    pub async fn recv(&mut self) -> Result<Option<Event>, Error> {
        match self.output.recv().await {
            Some(event) => Ok(Some(event)),
            None if self.sender.slow.load(Ordering::Acquire) => Err(Error::SlowConsumer),
            None => Ok(None),
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.output.close();
        self.cleanup.notify_one();
    }
}
