use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use server::{
    Backend, BackendConfig, Event,
    data::Storage,
    identity::{Identities, User},
    websocket::{self, HostedWeb, LocalAccess},
};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

#[path = "support/sdk.rs"]
mod sdk;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn event(socket: &mut Socket) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}

async fn call(socket: &mut Socket, kind: &str, name: &str) -> Value {
    call_args(socket, kind, name, json!({})).await
}

async fn call_args(socket: &mut Socket, kind: &str, name: &str, args: Value) -> Value {
    socket
        .send(Message::Text(
            json!({"type":kind,"id":1,"name":name,"args":args})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let value = event(socket).await;
    assert!(value["result"].get("Err").is_none(), "{value}");
    value["result"]["Ok"].clone()
}

#[test]
fn hosted_members_have_distinct_callers_and_revocation_closes_sockets() {
    sdk::run(
        async {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(directory.path().join("index.html"), "test").unwrap();
            let owner = "0123456789abcdef0123456789abcdef";
            let member_file = directory.path().join("members.json");
            let members: Vec<_> = ["Alice", "Bob"]
                .into_iter()
                .map(|name| {
                    let key = format!("fixture-key-{name}");
                    json!({"id":name,"name":name,"role":"member","created_at":1,
                    "devices":[{"id":format!("device-{name}"),"name":"Test device","kind":"device",
                        "token_hash":format!("{:x}", Sha256::digest(key))}]})
                })
                .collect();
            std::fs::write(&member_file, json!(members).to_string()).unwrap();
            let identities = Arc::new(Identities::hosted(member_file, owner, "Owner").unwrap());
            let backend = Backend::start(BackendConfig {
                storage: Storage::Memory,
                bundle: sdk::bundle(),
                javascript: Default::default(),
            })
            .await
            .unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let http = format!("http://{address}");
            let web = HostedWeb::configure(Some(directory.path().to_owned()), address).unwrap();
            let (stop, shutdown) = tokio::sync::oneshot::channel();
            let serving = tokio::spawn(websocket::serve_with_identities(
                listener,
                backend.server().clone(),
                async {
                    let _ = shutdown.await;
                },
                Some(LocalAccess {
                    token: owner.into(),
                    identity: json!({}),
                }),
                web,
                identities.clone(),
            ));
            let client = reqwest::Client::new();
            let mut sockets = Vec::new();
            let mut users = Vec::new();
            let mut tokens = Vec::new();
            for name in ["Alice", "Bob"] {
                let (socket, user, token) = verify_member(&client, &http, name).await;
                tokens.push(token);
                users.push(user);
                sockets.push(socket);
            }
            // A live query must retain the subscriber's identity after another member writes.
            sockets[0]
                .send(Message::Text(
                    json!({"type":"subscribe","id":2,"name":"probe:whoQuery","args":{}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            assert_eq!(
                event(&mut sockets[0]).await["result"]["Ok"]["user"],
                json!(users[0])
            );
            call(&mut sockets[1], "mutation", "probe:whoMutation").await;
            assert_eq!(
                event(&mut sockets[0]).await["result"]["Ok"]["user"],
                json!(users[0])
            );
            rename_and_revoke(&client, &http, owner, &tokens, &users, &mut sockets).await;
            drop(sockets);
            stop.send(()).unwrap();
            serving.await.unwrap().unwrap();
            backend.close().await.unwrap();
        },
        90,
    );
}

#[test]
fn local_mode_supplies_the_local_owner() {
    sdk::run(
        async {
            let backend = Backend::start(BackendConfig {
                storage: Storage::Memory,
                bundle: sdk::bundle(),
                javascript: Default::default(),
            })
            .await
            .unwrap();
            let mut session = backend.connect().await.unwrap();
            session.call(1, "probe:whoQuery", json!({})).unwrap();
            let Some(Event::Response {
                result: Ok(value), ..
            }) = session.recv().await.unwrap()
            else {
                panic!("missing query response")
            };
            assert_eq!(value["user"], json!(User::local()));
            assert_eq!(value["user"]["id"], "local");
            assert_eq!(value["user"]["role"], "owner");
            drop(session);
            backend.close().await.unwrap();
        },
        90,
    );
}

async fn account(client: &reqwest::Client, http: &str, token: &str) -> Value {
    let response = client
        .get(format!("{http}/account"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    serde_json::from_str(&response.text().await.unwrap()).unwrap()
}
async fn verify_member(client: &reqwest::Client, http: &str, name: &str) -> (Socket, User, String) {
    let token = format!("fixture-key-{name}");
    let user: User = serde_json::from_value(account(client, http, &token).await).unwrap();
    let response = client
        .get(format!("{http}/account"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response.text().await.unwrap()).unwrap(),
        json!(user)
    );
    let url = format!("{}/ws", http.replace("http://", "ws://"));
    let mut request = url.as_str().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        call(&mut socket, "query", "probe:whoQuery").await["user"],
        json!(user)
    );
    assert_eq!(
        call(&mut socket, "mutation", "probe:whoMutation").await,
        json!(user)
    );
    let action = call(&mut socket, "action", "probe:whoAction").await;
    assert_eq!(action["user"], json!(user));
    assert_eq!(action["query"]["user"], json!(user));
    assert_eq!(action["mutation"], json!(user));
    assert_member_forbidden(client, http, &token).await;

    assert_eq!(
        call(&mut socket, "query", "tokamak:whoami").await,
        json!(user)
    );
    (socket, user, token)
}
async fn assert_member_forbidden(client: &reqwest::Client, http: &str, token: &str) {
    for (method, path) in [
        (reqwest::Method::GET, "/members"),
        (reqwest::Method::POST, "/members"),
        (reqwest::Method::POST, "/members/owner/revoke"),
        (reqwest::Method::POST, "/shutdown"),
        (reqwest::Method::POST, "/plugins/chat/reload"),
    ] {
        assert_eq!(
            client
                .request(method, format!("{http}{path}"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
}
async fn rename_and_revoke(
    client: &reqwest::Client,
    http: &str,
    owner: &str,
    tokens: &[String],
    users: &[User],
    sockets: &mut [Socket],
) {
    let response = client
        .post(format!("{http}/account"))
        .bearer_auth(&tokens[1])
        .body(json!({"name":"Robert"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        call(&mut sockets[1], "query", "probe:whoQuery").await["user"]["name"],
        "Robert"
    );
    let response = client
        .post(format!("{http}/members/{}/revoke", users[0].id))
        .bearer_auth(owner)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    // The write above may already have queued a subscription update; drain until close.
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(message)) = sockets[0].next().await {
            if message.is_close() {
                break;
            }
        }
    })
    .await
    .expect("revoked socket stayed open");
    assert_eq!(
        client
            .get(format!("{http}/account"))
            .bearer_auth(&tokens[0])
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let url = format!("{}/ws", http.replace("http://", "ws://"));
    let mut request = url.as_str().into_client_request().unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", tokens[0]).parse().unwrap(),
    );
    assert!(tokio_tungstenite::connect_async(request).await.is_err());
    assert_eq!(
        call(&mut sockets[1], "query", "probe:whoQuery").await["user"]["id"],
        users[1].id
    );
}

#[test]
fn real_server_exposes_authenticated_user_and_device_to_plugins() {
    let result = sdk::bun_script("auth-driver.mjs")
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "auth acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn shared_server_signs_in_with_an_owned_account_and_issues_independent_devices() {
    let result = sdk::bun_script("auth-driver.mjs")
        .args([env!("CARGO_BIN_EXE_tokamak-server"), "--sign-in"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "sign-in acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn shared_server_requires_members_to_replace_temporary_passwords_before_connecting() {
    let result = sdk::bun_script("auth-driver.mjs")
        .args([env!("CARGO_BIN_EXE_tokamak-server"), "--members"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "members acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
