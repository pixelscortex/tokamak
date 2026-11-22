use super::*;
use crate::identity::Role;

impl Coordinator {
    pub(super) fn respond(&mut self, session: u64, id: u64, result: Result<Json, String>) {
        self.emit(session, Event::Response { id, result });
    }

    pub(super) fn emit(&mut self, session: u64, mut event: Event) {
        if let Event::Response {
            result: Err(error), ..
        }
        | Event::Subscription {
            result: Err(error), ..
        } = &mut event
            && let Some(stack_start) = error.find("\n    at ")
            && self.sessions.get(&session).is_some_and(|client| {
                client.auth.caller.read().expect("auth lock").user.role != Role::Owner
            })
        {
            // Interpreter stack frames can contain the server's source paths.
            error.truncate(stack_start);
        }
        // Count serialized bytes without allocating an unbounded transport buffer.
        // Native routing envelopes are accounted for separately by the mailbox.
        struct Limit(usize);
        impl std::io::Write for Limit {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 += bytes.len();

                if self.0 > engine::MAX_WIRE_MESSAGE_BYTES {
                    return Err(std::io::Error::other("result too large"));
                }

                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        if serde_json::to_writer(&mut Limit(0), &event).is_err() {
            event = match event {
                Event::Response { id, .. } => Event::Response {
                    id,
                    result: Err("result too large (1 MiB limit)".into()),
                },
                Event::Subscription { id, .. } => {
                    if let Some(client) = self.sessions.get_mut(&session) {
                        client.subscriptions.remove(&id);
                    }
                    // Response is also the protocol's terminal subscription
                    // failure: SDK releases its observer/capacity immediately.
                    Event::Response {
                        id,
                        result: Err("result too large (1 MiB limit); subscription ended".into()),
                    }
                }
                Event::PluginChanged { catalog, .. } => {
                    // The complete catalog is already paged. Clients diff it
                    // after assembly, so an arbitrarily large list of changed
                    // identities need not fit a single notification envelope.
                    Event::PluginChanged {
                        plugins: Vec::new(),
                        catalog,
                    }
                }
                _ => return,
            };
        }

        let Some(client) = self.sessions.get(&session) else {
            return;
        };
        if let Err(error) = client.output.try_send(event) {
            if matches!(error, mpsc::error::TrySendError::Full(_)) {
                client.slow.store(true, Ordering::Release);
            }
            // Never block a writer on a slow client. Close the ENTIRE session,
            // so dropping an update cannot be mistaken for an intact barrier.
            self.sessions.remove(&session);
        }
    }
}
