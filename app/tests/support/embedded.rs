//! Retained in-process regression harness, not the desktop's production transport.
//! Requests and replies are owned/bounded; JS callbacks never leave the UI thread.
use render::HostSender;
use server::{Backend, Event, Session, SessionSender, protocol::Request};
use tokio::sync::{mpsc, oneshot};
use tower::Service;

/// One nonblocking admission policy shared by the executable and host checks.
/// Reject before enqueueing so neither oversized messages nor excess requests
/// can grow the native-to-backend backlog.
pub(crate) fn admission() -> (render::MessageSender, mpsc::Receiver<String>) {
    let (requests, receiver) = mpsc::channel(64);
    let send: render::MessageSender = Box::new(move |message| {
        if message.len() > 64 * 1024 {
            return Err(render::Error("Native request exceeds 64 KiB".into()));
        }
        requests
            .try_send(message)
            .map_err(|e| render::Error(format!("Native request not admitted: {e}")))
    });
    (send, receiver)
}

/// Admit at most ONE native command until its completion has been consumed from
/// the ordered stream. Merely yielding an admission loop is insufficient: cheap
/// commands can otherwise fill all 32 server outputs in one ready executor poll.
enum Completion {
    Response(u64),
    Subscription(u64),
    Unsubscribed(u64),
}

impl Completion {
    fn for_request(request: &Request) -> Self {
        match request {
            Request::Query { id, .. }
            | Request::Mutation { id, .. }
            | Request::Action { id, .. }
            | Request::Plugins { id }
            | Request::PluginsPage { id, .. }
            | Request::PluginAsset { id, .. } => Self::Response(*id),
            Request::Subscribe { id, .. } => Self::Subscription(*id),
            Request::Unsubscribe { id } => Self::Unsubscribed(*id),
        }
    }

    fn matches(&self, event: &Event) -> bool {
        match (self, event) {
            (Self::Response(expected), Event::Response { id, .. })
            | (Self::Subscription(expected), Event::Subscription { id, .. })
            | (Self::Subscription(expected), Event::Response { id, .. })
            | (Self::Unsubscribed(expected), Event::Unsubscribed { id }) => expected == id,
            _ => false,
        }
    }
}

fn terminal_reason(reason: &str) -> String {
    // Parser/validation errors can quote almost the entire 64 KiB request.
    // At most 1024 Unicode scalars need <=6144 JSON bytes even when escaped;
    // this terminal diagnostic always fits its reserved mailbox envelope.
    const SUFFIX: &str = "; native connection closed; mutation outcomes may be unknown";
    let mut diagnostic: String = reason.chars().take(1024 - SUFFIX.len()).collect();
    diagnostic.push_str(SUFFIX);
    diagnostic
}

fn finish(output: HostSender, diagnostic: String) {
    // UI teardown retires the generation before its queued close/stop controls
    // can reach this worker. There is no live owner to notify in that interval.
    if output.is_document_retired() {
        return;
    }
    if output.finish("connection:close", diagnostic).is_err() {
        // Retirement can race the send itself. A still-live generation with a
        // failed terminal delivery is a real failure, not an expected close.
        if !output.is_document_retired() {
            eprintln!("Native terminal delivery failed: live mailbox rejected terminal event");
        }
    }
}

enum Failure {
    Backend,
    Admission,
    Delivery,
    Protocol {
        category: serde_json::error::Category,
        line: usize,
        column: usize,
    },
}

fn fail(output: Option<HostSender>, failure: Failure, reason: &str) {
    // Preserve the original backend/protocol failure even if the owner retires
    // later, but never persist its text: parser/backend errors can echo private
    // request values. Only typed categories and parser positions go to stderr.
    match failure {
        Failure::Backend => eprintln!("Native connection failed: backend"),
        Failure::Admission => eprintln!("Native connection failed: admission"),
        Failure::Delivery => eprintln!("Native connection failed: event delivery"),
        Failure::Protocol {
            category,
            line,
            column,
        } => {
            eprintln!(
                "Native connection failed: protocol ({category:?}, line {line}, column {column})"
            );
        }
    }
    if let Some(output) = output {
        // Detail remains bounded and private to the connection's live UI owner.
        finish(output, terminal_reason(reason));
    }
}

pub async fn serve(
    backend: Backend,
    mut session: Session,
    mut requests: mpsc::Receiver<String>,
    mut host: oneshot::Receiver<HostSender>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<(), server::Error> {
    let (mut output, mut closing) = tokio::select! {
        result = &mut host => (result.ok(), false),
        _ = &mut stopped => (None, true),
    };
    if output.is_none() {
        closing = true;
    }
    if closing {
        requests.close();
    }
    let mut sender = session.sender().with_backpressure();
    let mut admission: Option<<SessionSender as Service<Request>>::Future> = None;
    let mut awaiting: Option<Completion> = None;
    let mut acknowledged = false;
    let mut receiving = true;
    loop {
        if output.as_ref().is_some_and(HostSender::is_document_retired) {
            output = None;
            closing = true;
            requests.close();
        }
        if admission.is_none() && acknowledged {
            awaiting = None;
            acknowledged = false;
        }
        tokio::select! {
            biased;
            _ = &mut stopped, if !closing => {
                output = None;
                closing = true;
                requests.close();
            },
            event = session.recv(), if receiving => {
                let failure = match event {
                    Ok(Some(event)) => {
                        if awaiting.as_ref().is_some_and(|expected| expected.matches(&event)) {
                            acknowledged = true;
                        }
                        let delivered = output.as_ref().map(|output|
                            output.send("connection:event", event));
                        if output.as_ref().is_some_and(HostSender::is_document_retired) {
                            output = None;
                            closing = true;
                            requests.close();
                            None
                        } else {
                            delivered.and_then(Result::err)
                                .map(|e| (Failure::Delivery, e.to_string()))
                        }
                    },
                    Ok(None) => {
                        receiving = false;
                        awaiting = None;
                        Some((Failure::Backend, "Backend session closed".into()))
                    },
                    Err(error) => {
                        receiving = false;
                        awaiting = None;
                        Some((Failure::Backend, error.to_string()))
                    },
                };
                if let Some((failure, reason)) = failure {
                    fail(output.take(), failure, &reason);
                    closing = true;
                    requests.close();
                }
            },
            result = async { admission.as_mut().expect("guarded admission").await }, if admission.is_some() => {
                admission = None;
                if let Err(error) = result {
                    awaiting = None;
                    acknowledged = false;
                    fail(output.take(), Failure::Admission, &error.to_string());
                    closing = true;
                    requests.close();
                }
            },
            message = requests.recv(), if admission.is_none() && awaiting.is_none() => {
                let Some(message) = message else { break };
                match serde_json::from_str::<Option<Request>>(&message) {
                    Ok(Some(request)) => {
                        awaiting = Some(Completion::for_request(&request));
                        // Retain the permit future AND completion obligation
                        // through stop. Never cancel/retry possibly admitted work.
                        admission = Some(Service::call(&mut sender, request));
                    },
                    Ok(None) => {
                        output = None;
                        closing = true;
                        requests.close();
                    },
                    Err(error) => {
                        let failure = Failure::Protocol {
                            category: error.classify(),
                            line: error.line(),
                            column: error.column(),
                        };
                        fail(output.take(), failure, &error.to_string());
                        closing = true;
                        requests.close();
                    },
                }
            }
        }
    }
    if let Some(output) = output {
        finish(output, terminal_reason("Native connection closed"));
    }
    // Every buffered request has now passed admission and completion, even on
    // window close. Retiring subscriptions precedes the final disk-lock barrier.
    drop(session);
    backend.close().await
}
