//! Bounded native client transport. The independent server owns accepted writes.
use futures_util::{SinkExt, StreamExt};
use render::HostSender;
use serde_json::Value;
use std::{collections::BTreeSet, path::Path, time::Duration};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot},
    time::Instant,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn connect(directory: &Path) -> Result<Socket, Error> {
    let (server, token) = if let Some(profile) = super::remote::load(directory)? {
        (
            super::invite::server_url(&profile.server, true)?,
            profile.token,
        )
    } else {
        let descriptor: Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join("server.json"))
                .map_err(|_| "Local server is not running; use `bun run app`")?,
        )?;
        let server = descriptor["url"]
            .as_str()
            .ok_or("Invalid server discovery")?;
        let server = super::invite::server_url(server, false)?;
        let path = directory.join("server.token");
        let token = super::private_file::read(&path)?.ok_or("Missing server token")?;
        super::private_file::validate_token(&token)?;
        (server, token)
    };
    let mut request = server.as_str().into_client_request()?;
    let mut authorization =
        format!("Bearer {token}").parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()?;
    authorization.set_sensitive(true);
    request.headers_mut().insert("authorization", authorization);
    let config = WebSocketConfig::default()
        .write_buffer_size(0)
        .max_write_buffer_size(2 * render::MAX_WIRE_MESSAGE_BYTES)
        .max_message_size(Some(render::MAX_WIRE_MESSAGE_BYTES))
        .max_frame_size(Some(render::MAX_WIRE_MESSAGE_BYTES));
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async_with_config(request, Some(config), true),
    )
    .await??;
    Ok(socket)
}

pub fn admission() -> (render::MessageSender, mpsc::Receiver<String>) {
    let (requests, receiver) = mpsc::channel(64);
    (
        Box::new(move |message: String| {
            if message.len() > render::MAX_WIRE_MESSAGE_BYTES {
                return Err(render::Error("request too large (1 MiB limit)".into()));
            }
            requests
                .try_send(message)
                .map_err(|_| render::Error("Native request not admitted".into()))
        }),
        receiver,
    )
}

fn header(value: &Value, event: bool) -> Option<(&str, u64)> {
    let kind = value["type"].as_str()?;
    if event && kind == "pluginchanged" {
        value["plugins"]
            .as_array()?
            .iter()
            .all(Value::is_string)
            .then_some(())?;
        value["catalog"].as_object()?;
        return Some((kind, 0));
    }
    let id = value["id"]
        .as_u64()
        .filter(|id| *id <= 9_007_199_254_740_991)?;
    if event {
        match kind {
            "unsubscribed" => {}
            "response" | "subscription" => {
                let result = value["result"].as_object()?;
                if result.len() != 1
                    || !(result.contains_key("Ok")
                        || result.get("Err").is_some_and(Value::is_string))
                {
                    return None;
                }
            }
            _ => return None,
        }
    } else {
        match kind {
            "query" | "mutation" | "action" | "subscribe" => {
                value["name"].as_str()?;
                value.as_object()?.get("args")?;
            }
            "unsubscribe" | "plugins" => {}
            "pluginspage" => {
                value["revision"].as_str()?;
                value["offset"].as_u64()?;
            }
            "pluginasset" => {
                value["plugin"].as_str()?;
                value["name"].as_str()?;
                value["revision"].as_str()?;
                value["offset"].as_u64()?;
            }
            _ => return None,
        }
    }
    Some((kind, id))
}

fn complete(expected: &Option<(String, u64)>, event: &Value) -> bool {
    let Some((kind, id)) = header(event, true) else {
        return false;
    };
    expected.as_ref().is_some_and(|(want, expected)| {
        *expected == id && (want == kind || (want == "subscription" && kind == "response"))
    })
}

fn forward_event(sender: &HostSender, value: &Value) -> Result<(), Error> {
    let Err(error) = sender.send("connection:event", value) else {
        return Ok(());
    };
    // Size is a per-operation failure, never a transport failure.
    if !error.to_string().contains("result too large") {
        return Err(error.into());
    }
    let kind = value["type"].as_str().unwrap_or("response");
    let failure = serde_json::json!({"type":kind,"id":value["id"],
        "result":{"Err":"result too large (1 MiB limit)"}});
    sender.send("connection:event", failure)?;
    Ok(())
}

pub async fn serve(
    mut socket: Socket,
    mut requests: mpsc::Receiver<String>,
    mut host: oneshot::Receiver<HostSender>,
    mut stopped: oneshot::Receiver<()>,
) {
    let mut output = tokio::select! {
        host = &mut host => host.ok(),
        _ = &mut stopped => None,
    };
    let mut closing = output.is_none();
    let mut deadline = Instant::now() + Duration::from_secs(5);
    let mut awaiting: Option<(String, u64)> = None;
    // Long actions must not prevent the same client from sending the queries
    // and mutations that remain on the ordered lane. Bound outstanding IDs.
    let mut actions = BTreeSet::new();
    if closing {
        requests.close();
    }
    loop {
        tokio::select! {
            biased;
            _ = &mut stopped, if !closing => {
                output = None;
                closing = true;
                requests.close();
                deadline = Instant::now() + Duration::from_secs(5);
            },
            _ = tokio::time::sleep_until(deadline), if closing => break,
            event = socket.next() => {
                match event {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { break };
                        if header(&value, true).is_none() { break; }
                        if complete(&awaiting, &value) { awaiting = None; }
                        if value["type"] == "response" && let Some(id) = value["id"].as_u64() { actions.remove(&id); }
                        if let Some(sender) = &output {
                            if sender.is_document_retired() {
                                output = None;
                                closing = true;
                                requests.close();
                                deadline = Instant::now() + Duration::from_secs(5);
                            } else if forward_event(sender, &value).is_err() {
                                break;
                            }
                        }
                    },
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                    _ => break,
                }
            },
            message = requests.recv(), if awaiting.is_none() => {
                let Some(message) = message else { break };
                let Ok(request) = serde_json::from_str::<Value>(&message) else { break };
                if request.is_null() {
                    output = None;
                    closing = true;
                    requests.close();
                    deadline = Instant::now() + Duration::from_secs(5);
                    continue;
                }
                let Some((kind, id)) = header(&request, false) else { break };
                if kind == "action" {
                    if actions.len() >= 34 {
                        // Refuse before sending rather than letting a saturated
                        // action lane hold unrelated query/mutation messages.
                        if let Some(sender) = &output
                            && sender.send("connection:event", serde_json::json!({
                                "type":"response", "id":id,
                                "result":{"Err":"native action capacity exceeded; request was not admitted"}
                            })).is_err() { break; }
                        continue;
                    }
                    actions.insert(id);
                } else {
                    awaiting = Some((match kind {
                        "subscribe" => "subscription", "unsubscribe" => "unsubscribed", _ => "response",
                    }.into(), id));
                }
                if !matches!(tokio::time::timeout(Duration::from_secs(5),
                    socket.send(Message::Text(message.into()))).await, Ok(Ok(()))) { break; }
            }
        }
    }
    if let Some(sender) = output
        && !sender.is_document_retired()
    {
        let _ = sender.finish(
            "connection:close",
            "Server connection closed; mutation outcomes may be unknown",
        );
    }
    // Never retry a mutation or shut down the server when a window disappears.
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completion_headers_validate_network_events_before_acknowledging() {
        for value in [
            json!({"type":"response","id":1,"result":{"Ok":null}}),
            json!({"type":"response","id":1,"result":{"Err":"denied"}}),
            json!({"type":"subscription","id":1,"result":{"Ok":[]}}),
            json!({"type":"unsubscribed","id":1}),
        ] {
            assert!(serde_json::from_value::<::server::Event>(value.clone()).is_ok());
            assert!(header(&value, true).is_some());
        }
        for value in [
            json!({"type":"response","id":1}),
            json!({"type":"response","id":1,"result":{"Err":null}}),
            json!({"type":"response","id":1,"result":{"Ok":null,"Err":"bad"}}),
            json!({"type":"response","id":1.5,"result":{"Ok":null}}),
            json!({"type":"response","id":-1,"result":{"Ok":null}}),
            json!({"type":"unknown","id":1,"result":{"Ok":null}}),
        ] {
            assert!(serde_json::from_value::<::server::Event>(value.clone()).is_err());
            assert!(header(&value, true).is_none());
        }
        assert!(
            header(
                &json!({"type":"response","id":9_007_199_254_740_992u64,
            "result":{"Ok":null}}),
                true
            )
            .is_none()
        );
    }
}
