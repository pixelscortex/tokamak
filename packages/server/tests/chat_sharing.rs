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
    model_chunks: Arc<tokio::sync::Semaphore>,
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
        let model_chunks = Arc::new(tokio::sync::Semaphore::new(0));
        let chunks = model_chunks.clone();
        let router = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move |body: String| {
            let captured = captured.clone();
            let chunks = chunks.clone();
            async move {
                let request_number = {
                    let mut requests = captured.lock().unwrap();
                    requests.push(serde_json::from_str::<Value>(&body).unwrap());
                    requests.len()
                };
                let request: Value = serde_json::from_str(&body).unwrap();
                let messages = request["messages"].as_array().unwrap();
                if messages.last().is_some_and(|message| message["content"].as_str().is_some_and(|text| text.starts_with("tool:"))) {
                    let data = json!({"id":"tool","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"todo__todos_create","arguments":"{\"title\":\"Approved task\"}"}}]},"finish_reason":null}]});
                    let end = json!({"id":"tool","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
                    return axum::response::Response::builder().header("content-type", "text/event-stream")
                        .body(axum::body::Body::from(format!("data: {data}\n\ndata: {end}\n\ndata: [DONE]\n\n"))).unwrap();
                }
                let (send, receive) = tokio::sync::mpsc::channel(4);
                tokio::spawn(async move {
                    for text in ["Hello ", "world"] {
                        let data = json!({"id":"mock","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
                        if send.send(Ok::<_, std::io::Error>(format!("data: {data}\n\n"))).await.is_err() { return; }
                        // Hold the visibility probe and the run that the guest cancels.
                        if text == "Hello " && matches!(request_number, 1 | 3) {
                            tokio::select! {
                                permit = chunks.acquire() => permit.unwrap().forget(),
                                _ = send.closed() => return,
                            }
                        }
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
            model_chunks,
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
    fixture.model_chunks.add_permits(1);
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
    denied(
        &mut guest,
        "mutation",
        "chat/runs:observe",
        json!({"sweepId":"guest","tick":0}),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_tools_require_approval_after_guest_history() {
    let fixture = Fixture::new().await;
    fixture.model_chunks.add_permits(3);
    let member = fixture.member().await;
    let mut owner = connect(&fixture.local, OWNER).await.unwrap();
    let mut observer = connect(&fixture.local, OWNER).await.unwrap();
    let mut guest = fixture.socket(member["token"].as_str().unwrap()).await;
    for mode in ["private", "allow", "deny", "timeout", "cancel"] {
        let thread = call(&mut owner, "mutation", "chat/threads:create", json!({})).await;
        if mode != "private" {
            call(
                &mut owner,
                "mutation",
                "chat/threads:share",
                json!({"threadId":thread,"memberId":member["memberId"]}),
            )
            .await;
            assert_eq!(
                call(
                    &mut guest,
                    "action",
                    "chat/chat:send",
                    json!({"threadId":thread,"text":"Please create a task later"})
                )
                .await["status"],
                "done"
            );
            // Stored authorship still requires approval after access is revoked.
            call(
                &mut owner,
                "mutation",
                "chat/threads:unshare",
                json!({"threadId":thread,"memberId":member["memberId"]}),
            )
            .await;
        }
        let before = call(&mut observer, "query", "todo/todo:list", json!({}))
            .await
            .as_array()
            .unwrap()
            .len();
        send(
            &mut owner,
            50,
            "action",
            "chat/chat:send",
            json!({"threadId":thread,"text":"tool: create task"}),
        )
        .await;
        if mode != "private" {
            let (message, permission) = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let messages = call(
                        &mut observer,
                        "query",
                        "chat/messages:list",
                        json!({"threadId":thread}),
                    )
                    .await;
                    let message = messages.as_array().unwrap().last().unwrap();
                    if let Some(permission) = message["parts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|part| part["type"] == "permission")
                    {
                        break (message.clone(), permission.clone());
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(permission["status"], "pending");
            assert!(
                permission["title"]
                    .as_str()
                    .unwrap()
                    .starts_with("Run todo tool todos.create?")
            );
            assert!(
                permission["title"]
                    .as_str()
                    .unwrap()
                    .contains("Approved task")
            );
            let run = call(
                &mut observer,
                "query",
                "chat/runs:active",
                json!({"threadId":thread}),
            )
            .await;
            assert_eq!(run["waiting"], true);
            assert_eq!(
                call(&mut observer, "query", "todo/todo:list", json!({}))
                    .await
                    .as_array()
                    .unwrap()
                    .len(),
                before
            );
            let answer = json!({"messageId":message["_id"],"requestId":permission["requestId"],"optionId":if mode == "allow" { "allow_once" } else { "reject_once" }});
            denied(
                &mut guest,
                "mutation",
                "chat/permissions:answer",
                answer.clone(),
                "Not available to guests",
            )
            .await;
            if mode == "cancel" {
                call(
                    &mut observer,
                    "mutation",
                    "chat/runs:cancel",
                    json!({"runId":run["_id"]}),
                )
                .await;
            } else if mode != "timeout" {
                call(&mut observer, "mutation", "chat/permissions:answer", answer).await;
            }
        }
        let result = reply(&mut owner, 50).await;
        assert_eq!(
            result["result"]["Ok"]["status"],
            if mode == "cancel" {
                "cancelled"
            } else {
                "done"
            },
            "{result}"
        );
        let messages = call(
            &mut observer,
            "query",
            "chat/messages:list",
            json!({"threadId":thread}),
        )
        .await;
        let parts = messages.as_array().unwrap().last().unwrap()["parts"]
            .as_array()
            .unwrap();
        let tool = parts.iter().find(|part| part["type"] == "tool").unwrap();
        let allowed = mode == "private" || mode == "allow";
        assert_eq!(
            tool["status"],
            if allowed {
                "done"
            } else {
                "error"
            }
        );
        if mode == "private" {
            assert!(!parts.iter().any(|part| part["type"] == "permission"));
        } else if !allowed {
            assert_eq!(tool["error"], "The owner declined this tool call");
        }
        if mode == "deny" || mode == "timeout" {
            let requests = fixture.requests.lock().unwrap();
            assert!(
                requests.last().unwrap()["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| {
                        message["role"] == "tool"
                            && message["content"].as_str().is_some_and(|text| {
                                text.contains("The owner declined this tool call")
                            })
                    })
            );
        }
        assert_eq!(
            call(&mut observer, "query", "todo/todo:list", json!({}))
                .await
                .as_array()
                .unwrap()
                .len(),
            before + usize::from(allowed)
        );
        assert!(
            call(
                &mut observer,
                "query",
                "chat/runs:active",
                json!({"threadId":thread})
            )
            .await
            .is_null()
        );
    }
    drop(owner);
    drop(observer);
    drop(guest);
    clean(fixture).await;
}
