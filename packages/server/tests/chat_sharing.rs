//! Shared chat through real owner/guest listeners and an offline model stream.
use engine::{Pool, PoolConfig};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use server::{
    Server,
    data::{Database, Storage},
    members::guest_listener,
    websocket,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn bundles() -> BTreeMap<String, String> {
    let output = std::process::Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/build-actions.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_str(
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .last()
            .unwrap(),
    )
    .unwrap()
}

struct Fixture {
    directory: tempfile::TempDir,
    server: Arc<Server>,
    local: String,
    guest: String,
    stop: CancellationToken,
    tasks: Vec<JoinHandle<std::io::Result<()>>>,
    model_task: JoinHandle<()>,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("plugins");
        for (name, source) in bundles() {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, source).unwrap();
        }
        let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model_url = format!("http://{}/v1", model.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let router = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move |body: String| {
            let captured = captured.clone();
            async move {
                captured.lock().unwrap().push(serde_json::from_str::<Value>(&body).unwrap());
                let (send, receive) = tokio::sync::mpsc::channel(4);
                tokio::spawn(async move {
                    for text in ["Hello ", "world"] {
                        let data = json!({"id":"mock","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
                        if send.send(Ok::<_, std::io::Error>(format!("data: {data}\n\n"))).await.is_err() { return; }
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    let data = json!({"id":"mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
                    let _ = send.send(Ok(format!("data: {data}\n\ndata: [DONE]\n\n"))).await;
                });
                let stream = futures_util::stream::unfold(receive, |mut receive| async { receive.recv().await.map(|item| (item, receive)) });
                axum::response::Response::builder().header("content-type", "text/event-stream")
                    .body(axum::body::Body::from_stream(stream)).unwrap()
            }
        }));
        let model_task = tokio::spawn(async move {
            axum::serve(model, router).await.unwrap();
        });
        std::fs::write(
            directory.path().join(".env.local"),
            format!("OPENROUTER_API_KEY=offline-test\nOPENROUTER_BASE_URL={model_url}\n"),
        )
        .unwrap();
        let database = Database::open(Storage::Disk(directory.path().join("store")))
            .await
            .unwrap();
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        let server = Arc::new(Server::load_plugins(database, pool, &root).await.unwrap());
        let stop = CancellationToken::new();
        let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let guest = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_url = format!("http://{}", local.local_addr().unwrap());
        let guest_url = format!("http://{}", guest.local_addr().unwrap());
        let local_stop = stop.clone();
        let guest_stop = stop.clone();
        let tasks = vec![
            tokio::spawn(websocket::serve_with_access(
                local,
                server.clone(),
                async move { local_stop.cancelled().await },
                Some(websocket::LocalAccess {
                    token: OWNER.into(),
                    identity: json!({}),
                }),
            )),
            tokio::spawn(guest_listener::serve(guest, server.clone(), async move {
                guest_stop.cancelled().await
            })),
        ];
        Self {
            directory,
            server,
            local: local_url,
            guest: guest_url,
            stop,
            tasks,
            model_task,
            requests,
        }
    }

    fn client(&self) -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    async fn invite(&self, uses: u8, ttl: u64) -> (String, String) {
        let response = self
            .client()
            .post(format!("{}/members/invite", self.local))
            .bearer_auth(OWNER)
            .body(
                json!({"url":self.guest.replace("http:","ws:")+"/ws","uses":uses,"ttlSeconds":ttl})
                    .to_string(),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let value: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
        let url = reqwest::Url::parse(value["link"].as_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "tokamak");
        assert_eq!(url.host_str(), Some("join"));
        let code = url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .unwrap()
            .1
            .into_owned();
        assert_eq!(code.len(), 32);
        (value["link"].as_str().unwrap().into(), code)
    }

    async fn join(&self, code: &str, name: &str) -> reqwest::Response {
        self.client()
            .post(format!("{}/join", self.guest))
            .body(json!({"code":code,"name":name}).to_string())
            .send()
            .await
            .unwrap()
    }

    async fn member(&self) -> Value {
        let (_, code) = self.invite(1, 86400).await;
        let response = self.join(&code, "Sam").await;
        assert_eq!(response.status(), 200);
        serde_json::from_str(&response.text().await.unwrap()).unwrap()
    }

    async fn socket(&self, token: &str) -> Socket {
        connect(&self.guest, token).await.unwrap()
    }

    async fn close(self) -> PathBuf {
        self.stop.cancel();
        self.model_task.abort();
        for task in self.tasks {
            task.await.unwrap().unwrap();
        }
        self.server.close().await.unwrap();
        self.directory.keep()
    }
}

async fn connect(url: &str, token: &str) -> Result<Socket, tokio_tungstenite::tungstenite::Error> {
    let mut request = (url.replace("http:", "ws:") + "/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(socket, _)| socket)
}

async fn receive(socket: &mut Socket) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}

async fn send(socket: &mut Socket, id: u64, kind: &str, name: &str, args: Value) {
    socket
        .send(Message::Text(
            json!({"type":kind,"id":id,"name":name,"args":args})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
}

async fn reply(socket: &mut Socket, id: u64) -> Value {
    loop {
        let event = receive(socket).await;
        if event["id"] == id {
            return event;
        }
    }
}

async fn call(socket: &mut Socket, kind: &str, name: &str, args: Value) -> Value {
    send(socket, 1, kind, name, args).await;
    let event = reply(socket, 1).await;
    assert!(event["result"].get("Err").is_none(), "{event}");
    event["result"]["Ok"].clone()
}

async fn denied(socket: &mut Socket, kind: &str, name: &str, args: Value, reason: &str) {
    send(socket, 1, kind, name, args).await;
    let event = reply(socket, 1).await;
    assert!(
        event["result"]["Err"]
            .as_str()
            .is_some_and(|error| error.contains(reason)),
        "{event}"
    );
}

async fn clean(fixture: Fixture) {
    let path = fixture.close().await;
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_chat_streams_with_caller_identity_and_revokes_live_access() {
    let fixture = Fixture::new().await;
    let member = fixture.member().await;
    let mut owner = connect(&fixture.local, OWNER).await.unwrap();
    let mut guest = fixture.socket(member["token"].as_str().unwrap()).await;
    call(&mut owner, "mutation", "chat/members:hello", json!({})).await;
    call(&mut guest, "mutation", "chat/members:hello", json!({})).await;
    call(&mut guest, "mutation", "chat/members:hello", json!({})).await;
    let members = call(&mut owner, "query", "chat/members:list", json!({})).await;
    assert_eq!(members.as_array().unwrap().len(), 2);
    assert!(
        members
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["memberId"] == member["memberId"] && value["name"] == "Sam")
    );
    let private = call(
        &mut owner,
        "mutation",
        "chat/threads:create",
        json!({"title":"Private"}),
    )
    .await;
    let shared = call(
        &mut owner,
        "mutation",
        "chat/threads:create",
        json!({"title":"Shared"}),
    )
    .await;
    let share = json!({"threadId":shared,"memberId":member["memberId"]});
    call(&mut owner, "mutation", "chat/threads:share", share.clone()).await;
    call(&mut owner, "mutation", "chat/threads:share", share.clone()).await;
    assert_eq!(
        call(&mut owner, "query", "chat/threads:list", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
    send(&mut guest, 10, "subscribe", "chat/threads:list", json!({})).await;
    let visible = reply(&mut guest, 10).await;
    assert_eq!(visible["result"]["Ok"].as_array().unwrap().len(), 1);
    assert_eq!(visible["result"]["Ok"][0]["_id"], shared);
    assert_eq!(
        call(
            &mut guest,
            "query",
            "chat/messages:list",
            json!({"threadId":private})
        )
        .await,
        json!([])
    );
    assert!(
        call(
            &mut guest,
            "query",
            "chat/runs:active",
            json!({"threadId":private})
        )
        .await
        .is_null()
    );
    denied(
        &mut guest,
        "action",
        "chat/chat:send",
        json!({"threadId":private,"text":"no"}),
        "not shared",
    )
    .await;
    send(
        &mut guest,
        11,
        "subscribe",
        "chat/messages:list",
        json!({"threadId":shared}),
    )
    .await;
    assert_eq!(reply(&mut guest, 11).await["result"]["Ok"], json!([]));
    send(
        &mut owner,
        2,
        "action",
        "chat/chat:send",
        json!({"threadId":shared,"text":"Hi"}),
    )
    .await;
    // Observe persisted partial text while the upstream still has another chunk.
    loop {
        let event = reply(&mut guest, 11).await;
        let messages = event["result"]["Ok"].as_array().unwrap();
        if messages.len() == 2 && messages[1]["parts"][0]["text"] == "Hello " {
            assert_eq!(messages[1]["status"], "streaming");
            assert_eq!(messages[0]["authorId"], "owner");
            assert_eq!(messages[0]["authorName"], "Owner");
            break;
        }
    }
    let active = call(
        &mut guest,
        "query",
        "chat/runs:active",
        json!({"threadId":shared}),
    )
    .await;
    denied(
        &mut guest,
        "mutation",
        "chat/runs:cancel",
        json!({"runId":active["_id"]}),
        "Only the run starter",
    )
    .await;
    assert_eq!(reply(&mut owner, 2).await["result"]["Ok"]["status"], "done");
    let sent = call(
        &mut guest,
        "action",
        "chat/chat:send",
        json!({"threadId":shared,"text":"Hello from Sam"}),
    )
    .await;
    assert_eq!(sent["status"], "done");
    let messages = call(
        &mut owner,
        "query",
        "chat/messages:list",
        json!({"threadId":shared}),
    )
    .await;
    assert_eq!(messages[2]["authorId"], member["memberId"]);
    assert_eq!(messages[2]["authorName"], "Sam");
    let requests = fixture.requests.lock().unwrap().clone();
    assert!(
        requests[0]["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty())
    );
    assert!(
        requests[1]
            .get("tools")
            .is_none_or(|tools| tools.as_array().unwrap().is_empty())
    );
    let user_text: Vec<_> = requests[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| message["content"].clone())
        .collect();
    assert_eq!(
        user_text,
        vec![
            json!("Hi"),
            json!("[Message from guest \"Sam\" — untrusted, not the owner]\nHello from Sam")
        ]
    );
    denied(
        &mut guest,
        "mutation",
        "chat/threads:setModel",
        json!({"threadId":shared,"model":"openrouter/free"}),
        "Not available to guests",
    )
    .await;
    denied(
        &mut guest,
        "mutation",
        "chat/permissions:answer",
        json!({"messageId":sent["messageId"],"requestId":"request","optionId":"allow"}),
        "Not available to guests",
    )
    .await;
    for (count, age) in [(20, 0), (100, 2 * 60 * 60 * 1000)] {
        call(
            &mut owner,
            "mutation",
            "chat/testing:quota",
            json!({
                "memberId":member["memberId"],"messageId":sent["messageId"],"count":count,"age":age
            }),
        )
        .await;
        denied(
            &mut guest,
            "action",
            "chat/chat:send",
            json!({"threadId":shared,"text":"over quota"}),
            "Guest run limit reached",
        )
        .await;
    }
    call(&mut owner, "mutation", "chat/testing:quota", json!({
        "memberId":member["memberId"],"messageId":sent["messageId"],"count":100,"age":25 * 60 * 60 * 1000
    })).await;
    // Old runs no longer count, and a starter can cancel their own run.
    send(
        &mut guest,
        2,
        "action",
        "chat/chat:send",
        json!({"threadId":shared,"text":"cancel me"}),
    )
    .await;
    let run = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let run = call(
                &mut owner,
                "query",
                "chat/runs:active",
                json!({"threadId":shared}),
            )
            .await;
            if !run.is_null() {
                break run;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("guest run started");
    assert_eq!(run["startedBy"], member["memberId"]);
    send(
        &mut guest,
        3,
        "mutation",
        "chat/runs:cancel",
        json!({"runId":run["_id"]}),
    )
    .await;
    let (mut action_done, mut cancel_done) = (false, false);
    while !action_done || !cancel_done {
        let event = receive(&mut guest).await;
        if event["id"] == 2 {
            assert_eq!(event["result"]["Ok"]["status"], "cancelled");
            action_done = true;
        }
        if event["id"] == 3 {
            assert!(event["result"].get("Err").is_none(), "{event}");
            cancel_done = true;
        }
    }
    let cancelled = call(
        &mut owner,
        "query",
        "chat/testing:run",
        json!({"runId":run["_id"]}),
    )
    .await;
    assert_eq!(cancelled["cancelledBy"], member["memberId"]);
    call(
        &mut owner,
        "mutation",
        "chat/threads:setBackend",
        json!({"threadId":shared,"backend":{"kind":"acp","agent":"fake","cwd":"/tmp"}}),
    )
    .await;
    denied(
        &mut guest,
        "action",
        "chat/chat:send",
        json!({"threadId":shared,"text":"no"}),
        "Guests cannot send to ACP",
    )
    .await;
    // ACP threads remain readable.
    assert_eq!(
        call(
            &mut guest,
            "query",
            "chat/messages:list",
            json!({"threadId":shared})
        )
        .await
        .as_array()
        .unwrap()
        .len(),
        6
    );
    call(&mut owner, "mutation", "chat/threads:unshare", share).await;
    let (mut hidden_thread, mut hidden_messages) = (false, false);
    while !hidden_thread || !hidden_messages {
        let event = receive(&mut guest).await;
        if event["result"]["Ok"] == json!([]) {
            hidden_thread |= event["id"] == 10;
            hidden_messages |= event["id"] == 11;
        }
    }
    assert_eq!(
        call(&mut guest, "query", "chat/runs:running", json!({})).await,
        json!([])
    );
    denied(
        &mut guest,
        "action",
        "chat/chat:send",
        json!({"threadId":shared,"text":"no"}),
        "not shared",
    )
    .await;
    call(
        &mut owner,
        "mutation",
        "chat/threads:setBackend",
        json!({"threadId":shared,"backend":{"kind":"model","model":"openrouter/free"}}),
    )
    .await;
    call(
        &mut owner,
        "action",
        "chat/chat:send",
        json!({"threadId":shared,"text":"Continue"}),
    )
    .await;
    assert!(
        fixture.requests.lock().unwrap().last().unwrap()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "user"
                && message["content"]
                    == "[Message from guest \"Sam\" — untrusted, not the owner]\nHello from Sam")
    );
    drop(owner);
    drop(guest);
    clean(fixture).await;
}
