use super::{
    Manager,
    session::{self, Lease, Stream},
};
use engine::OpRegistry;
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) fn register(
    ops: &mut OpRegistry,
    manager: Arc<Manager>,
    plugin: String,
    granted: bool,
) -> Result<(), engine::Error> {
    manager.bind_runtime();
    let lease = Arc::new(Lease::default());
    let catalog = manager.clone();
    let caller = plugin.clone();
    ops.register_sync("acp.agents", move |_| {
        authorize(granted)?;
        Ok(json!(
            catalog
                .config
                .agents
                .iter()
                .filter(|(_, agent)| agent.plugins.contains(&caller))
                .map(|(id, _)| json!({"id":id,"title":id}))
                .collect::<Vec<_>>()
        ))
    })?;

    for name in ["open", "prompt", "next", "respond", "cancel", "close"] {
        let manager = manager.clone();
        let plugin = plugin.clone();
        let lease = lease.clone();
        ops.register_async(format!("acp.{name}"), move |payload| {
            let manager = manager.clone();
            let plugin = plugin.clone();
            let lease = lease.clone();
            async move {
                authorize(granted)?;
                dispatch(&manager, &plugin, &lease, name, payload).await
            }
        })?;
    }
    Ok(())
}

fn authorize(granted: bool) -> Result<(), String> {
    if granted {
        Ok(())
    } else {
        Err("ACP permission denied: requires acp".into())
    }
}

fn text<'a>(payload: &'a Value, name: &str) -> Result<&'a str, String> {
    payload[name]
        .as_str()
        .ok_or_else(|| format!("ACP requires {name}"))
}

async fn dispatch(
    manager: &Manager,
    plugin: &str,
    lease: &Lease,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    if name == "next" || name == "close" {
        return stream_event(lease, name, &payload).await;
    }
    if name == "respond" {
        let id = text(&payload, "requestId")?;
        let option = payload["optionId"].as_str().map(str::to_owned);
        let streams: Vec<_> = lease
            .streams
            .lock()
            .expect("ACP streams")
            .values()
            .cloned()
            .collect();
        for stream in streams {
            match stream.process.respond(&lease.id, id, option.clone()).await {
                Err(error) if error == "Unknown ACP permission request" => continue,
                result => return result,
            }
        }
        return Err("Unknown ACP permission request".into());
    }

    let process = manager.process(plugin, text(&payload, "agent")?).await?;
    if name == "open" {
        return session::open(
            &process,
            text(&payload, "cwd")?,
            payload["sessionId"].as_str(),
        )
        .await;
    }
    let session = text(&payload, "sessionId")?;
    if name == "cancel" {
        process.cancel_session(session);
        return Ok(Value::Null);
    }
    let (events, receive) = tokio::sync::mpsc::unbounded_channel();
    let id = uuid::Uuid::new_v4().to_string();
    let stream = Arc::new(Stream {
        process: process.clone(),
        session: session.into(),
        events: tokio::sync::Mutex::new(receive),
    });
    lease
        .streams
        .lock()
        .expect("ACP streams")
        .insert(id.clone(), stream);
    if let Err(error) = process
        .prompt(&lease.id, session, text(&payload, "text")?, events)
        .await
    {
        lease.streams.lock().expect("ACP streams").remove(&id);
        return Err(error);
    }
    Ok(json!(id))
}

async fn stream_event(lease: &Lease, name: &str, payload: &Value) -> Result<Value, String> {
    let id = text(payload, "stream")?;
    let stream = lease.streams.lock().expect("ACP streams").get(id).cloned();
    let Some(stream) = stream else {
        return if name == "close" {
            Ok(Value::Null)
        } else {
            Err("Unknown ACP stream".into())
        };
    };
    if name == "close" {
        lease.streams.lock().expect("ACP streams").remove(id);
        stream.process.cancel(&lease.id, &stream.session);
        return Ok(Value::Null);
    }
    let event = stream
        .events
        .lock()
        .await
        .recv()
        .await
        .ok_or("ACP stream closed")?;
    if event.as_ref().map_or(true, |event| event["type"] == "done") {
        lease.streams.lock().expect("ACP streams").remove(id);
    }
    event
}
