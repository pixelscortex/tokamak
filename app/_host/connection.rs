//! App-owned wiring of the renderer MessageConnection to the ONE Tower session.
//! Requests and replies are owned/bounded; JS callbacks never leave the UI thread.
use render::HostSender;
use server::{Backend, Session, SessionSender, protocol::Request};
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

async fn admit(sender: &mut SessionSender, message: &str) -> Result<bool, String> {
    let request: Option<Request> = serde_json::from_str(message).map_err(|e| e.to_string())?;
    let Some(request) = request else {
        return Ok(false);
    };
    // Tower acknowledges admission only; application results arrive exclusively
    // through Session::recv, including subscription updates before writer replies.
    Service::call(sender, request)
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

pub async fn serve(
    backend: Backend,
    mut session: Session,
    mut requests: mpsc::Receiver<String>,
    mut host: oneshot::Receiver<HostSender>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<(), server::Error> {
    let mut sender = session.sender();
    let output = tokio::select! {
        result = &mut host => result.ok(),
        _ = &mut stopped => None,
    };
    let mut failure = None;
    if let Some(output) = &output {
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                message = requests.recv() => {
                    match message {
                        Some(message) => match admit(&mut sender, &message).await {
                            Ok(true) => {},
                            Ok(false) => break,
                            Err(error) => { failure = Some(error); break; }
                        },
                        None => break,
                    }
                },
                event = session.recv() => {
                    match event {
                        Ok(Some(event)) => {
                            if let Err(error) = output.send("connection:event", event) {
                                failure = Some(error.to_string());
                                break;
                            }
                        },
                        Ok(None) => { failure = Some("Backend session closed".into()); break; },
                        Err(error) => { failure = Some(error.to_string()); break; }
                    }
                }
            }
        }
        let _ = output.finish(
            "connection:close",
            failure.as_deref().unwrap_or("Native connection closed"),
        );
    }
    // Stop admission, then forward already queued requests without retrying.
    // Dropping the session cancels subscriptions, not admitted mutations; close
    // waits for the coordinator's commit barrier and SurrealKV disk-lock release.
    requests.close();
    while let Some(message) = requests.recv().await {
        if let Err(error) = admit(&mut sender, &message).await {
            eprintln!("Native request rejected during shutdown: {error}");
        }
    }
    drop(sender);
    drop(session);
    backend.close().await
}
