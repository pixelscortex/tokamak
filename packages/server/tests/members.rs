//! Task 1 acceptance through real SDK bundles, local controls and guest sockets.
use engine::{Pool, PoolConfig};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use server::{
    Server,
    data::{Database, Storage, Table},
    members::guest_listener,
    websocket,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, OnceLock},
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

fn bundles() -> &'static BTreeMap<String, String> {
    static BUNDLES: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    BUNDLES.get_or_init(|| {
        let directory = tempfile::tempdir().unwrap();
        let sdk = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sdk/src/index.ts");
        let common = format!("import {{query,mutation,action,createRegistry,functionMetadata,invokeFunction,createApi,defineSchema,schemaMetadata,v}} from {};\n", json!(sdk));
        let a = r#"
const api = createApi("a");
const other = createApi("b");
const functions = {
  identity: query({guest:true, args:{caller:v.optional(v.any())}, handler:ctx=>ctx.caller}),
  private: mutation({handler:ctx=>ctx.caller}),
  nested: action({guest:true, handler:async ctx=>({action:ctx.caller, mutation:await ctx.runMutation(api.test.private,{})})}),
  cross: query({guest:true, handler:ctx=>ctx.use(other).test.identity({})}),
  denied: query({handler:()=>"owner only"}),
  host: query({guest:true,handler:ctx=>ctx.db.query("h__members").collect()}),
  acp: action({guest:true,handler:ctx=>ctx.acp.agents()}),
  messageError: query({handler:()=>[{error:"failed: member-secret-do-not-echo", text:"member-secret-do-not-echo"}]}),
  nestedFailure: mutation({handler:(_ctx,args)=>{throw new Error(args.secret)},args:{secret:v.string()}}),
  caught: action({handler:async ctx=>{const secret=await ctx.env("MEMBER_TEST_SECRET");try{await ctx.runMutation(api.test.nestedFailure,{secret})}catch(error){return {error:error.message}}}}),
  delayedSecret: action({handler:async ctx=>{const secret=await ctx.env("MEMBER_TEST_SECRET");await new Promise(resolve=>setTimeout(resolve,300));throw new Error(secret+":"+await ctx.env("MEMBER_TEST_SECRET"))}}),
  failure: query({guest:true,handler:()=>{throw new Error("Public failure\nprivate /source/plugin.ts:10")}}),
  pathFailure: action({guest:true,handler:()=>{throw new Error("Cannot open /private/plugin.ts")}}),
  secret: action({guest:true,handler:async ctx=>{throw new Error("failed: "+await ctx.env("MEMBER_TEST_SECRET"))}}),
};
"#;
        let b = "const functions = {identity:query({handler:ctx=>ctx.caller})};";
        let mut result = BTreeMap::new();
        for (id, functions) in [("a",a),("b",b)] {
            let source = format!("{common}\n{functions}\nconst registry=createRegistry({{test:functions}});\nexport const describe=()=>({{functions:functionMetadata(registry),schema:schemaMetadata(defineSchema({{}}))}});\nexport const invoke=(request,host)=>invokeFunction(registry,request,host);\n");
            let path = directory.path().join(format!("{id}.ts"));
            std::fs::write(&path,source).unwrap();
            let script = "const r=await Bun.build({entrypoints:[process.argv[1]],target:'browser',format:'esm'});if(!r.success)throw new AggregateError(r.logs);console.log(await r.outputs[0].text())";
            let output = std::process::Command::new("proto").args(["run","bun","--","-e",script]).arg(&path).output().unwrap();
            assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
            result.insert(id.into(),String::from_utf8(output.stdout).unwrap());
        }
        result
    })
}

struct Fixture {
    directory: tempfile::TempDir,
    server: Arc<Server>,
    local: String,
    guest: String,
    stop: CancellationToken,
    tasks: Vec<JoinHandle<std::io::Result<()>>>,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("plugins");
        for (id, code) in bundles() {
            let path = root.join(id);
            std::fs::create_dir_all(&path).unwrap();
            let files = [
                ("bundle.js", code.as_str()),
                (
                    "bundle.js.map",
                    r#"{"version":3,"sources":[],"names":[],"mappings":""}"#,
                ),
                ("api.ts", "export {};"),
            ];
            let mut hashes = BTreeMap::new();
            for (name, text) in files {
                std::fs::write(path.join(name), text).unwrap();
                hashes.insert(name, format!("{:x}", Sha256::digest(text.as_bytes())));
            }
            let mut plugin = json!({"id":id,"version":"1.0.0","exports":"./api.ts"});
            if id == "a" {
                plugin["depends"] = json!({"b":"^1"});
                plugin["permissions"] = json!(["acp", "env:MEMBER_TEST_SECRET"]);
            }
            let manifest = json!({"formatVersion":1,"plugin":plugin,"entries":{"backend":{"code":"bundle.js","map":"bundle.js.map","api":"api.ts"}},"publicFunctions":["test:identity"],"hashes":hashes});
            std::fs::write(path.join("manifest.json"), manifest.to_string()).unwrap();
        }
        std::fs::write(
            directory.path().join(".env.local"),
            "MEMBER_TEST_SECRET=member-secret-do-not-echo\n",
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

async fn call(socket: &mut Socket, kind: &str, name: &str, args: Value) -> Value {
    socket
        .send(Message::Text(
            json!({"type":kind,"id":1,"name":name,"args":args})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    receive(socket).await
}

async fn clean(fixture: Fixture) {
    let path = fixture.close().await;
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invite_authentication_default_deny_and_revoke() {
    let fixture = Fixture::new().await;
    let (_, code) = fixture.invite(1, 86400).await;
    let response = fixture.join(&code, "Sam").await;
    assert_eq!(response.status(), 200);
    let member: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let token = member["token"].as_str().unwrap();
    assert_eq!(token.len(), 64);
    assert_eq!(fixture.join(&code, "Other").await.status(), 401);
    let mut socket = fixture.socket(token).await;
    assert_eq!(
        call(&mut socket, "query", "a/test:denied", json!({})).await["result"]["Err"],
        "Not available to guests"
    );
    assert_eq!(
        call(&mut socket, "query", "b/test:identity", json!({})).await["result"]["Err"],
        "Not available to guests"
    );
    let response = fixture
        .client()
        .post(format!(
            "{}/members/{}/revoke",
            fixture.local,
            member["memberId"].as_str().unwrap()
        ))
        .bearer_auth(OWNER)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .is_none_or(|message| message.is_err() || message.unwrap().is_close())
    );
    assert!(
        matches!(connect(&fixture.guest,token).await,Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status()==401)
    );
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caller_is_host_bound_and_survives_action_mutation_and_plugin_calls() {
    let fixture = Fixture::new().await;
    let member = fixture.member().await;
    let caller = json!({"memberId":member["memberId"],"name":"Sam","role":"guest"});
    let mut socket = fixture.socket(member["token"].as_str().unwrap()).await;
    assert_eq!(
        call(
            &mut socket,
            "query",
            "a/test:identity",
            json!({"caller":{"memberId":"owner","role":"owner"}})
        )
        .await["result"]["Ok"],
        caller
    );
    assert_eq!(
        call(&mut socket, "action", "a/test:nested", json!({})).await["result"]["Ok"],
        json!({"action":caller,"mutation":caller})
    );
    assert_eq!(
        call(&mut socket, "query", "a/test:cross", json!({})).await["result"]["Ok"],
        caller
    );
    let mut owner = connect(&fixture.local, OWNER).await.unwrap();
    assert_eq!(
        call(&mut owner, "action", "a/test:nested", json!({})).await["result"]["Ok"],
        json!({"action":{"memberId":"owner","name":"Owner","role":"owner"},"mutation":{"memberId":"owner","name":"Owner","role":"owner"}})
    );
    drop(socket);
    drop(owner);
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_listener_excludes_owner_controls_and_origins() {
    let fixture = Fixture::new().await;
    assert_eq!(
        fixture
            .client()
            .get(format!("{}/ws", fixture.guest))
            .bearer_auth(OWNER)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert!(
        matches!(connect(&fixture.guest,OWNER).await,Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status()==401)
    );
    for path in [
        "/health",
        "/shutdown",
        "/plugins",
        "/plugins/a/reload",
        "/plugins/a/assets/bundle.js",
        "/members",
        "/members/invite",
    ] {
        for method in [reqwest::Method::GET, reqwest::Method::POST] {
            assert_eq!(
                fixture
                    .client()
                    .request(method, format!("{}{path}", fixture.guest))
                    .bearer_auth(OWNER)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404,
                "{path}"
            );
        }
    }
    assert_eq!(
        fixture
            .client()
            .post(format!("{}/join", fixture.guest))
            .header("origin", "https://example.com")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let member = fixture.member().await;
    let token = member["token"].as_str().unwrap();
    let mut request = (fixture.guest.replace("http:", "ws:") + "/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    request
        .headers_mut()
        .insert("origin", "https://example.com".parse().unwrap());
    assert!(
        matches!(tokio_tungstenite::connect_async(request).await,Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status()==403)
    );
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_catalog_assets_acp_and_errors_are_restricted() {
    let fixture = Fixture::new().await;
    let member = fixture.member().await;
    let token = member["token"].as_str().unwrap();
    let mut socket = fixture.socket(token).await;
    socket
        .send(Message::Text(
            json!({"type":"plugins","id":1}).to_string().into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        receive(&mut socket).await["result"]["Ok"]["plugins"],
        json!([])
    );
    socket.send(Message::Text(json!({"type":"pluginasset","id":2,"plugin":"a","name":"bundle.js","revision":"guest","offset":0}).to_string().into())).await.unwrap();
    assert_eq!(
        receive(&mut socket).await["result"]["Err"],
        "Not available to guests"
    );
    assert!(
        call(&mut socket, "action", "a/test:acp", json!({})).await["result"]["Err"]
            .as_str()
            .unwrap()
            .contains("Not available to guests")
    );
    assert_eq!(
        call(&mut socket, "query", "a/test:host", json!({})).await["result"]["Err"]
            .as_str()
            .unwrap()
            .lines()
            .next()
            .unwrap(),
        "plugin data space does not own that record"
    );
    let secret = call(&mut socket, "action", "a/test:secret", json!({})).await;
    assert!(
        !secret.to_string().contains("member-secret-do-not-echo"),
        "{secret}"
    );
    fixture.server.reload_plugin("a".into()).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), socket.next())
            .await
            .is_err(),
        "guests must not receive pluginchanged"
    );
    drop(socket);
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invite_validation_uses_names_and_join_attempt_limit() {
    let fixture = Fixture::new().await;
    for (uses, ttl) in [(0, 10), (11, 10), (1, 0), (1, 604801)] {
        assert_eq!(
            fixture
                .client()
                .post(format!("{}/members/invite", fixture.local))
                .bearer_auth(OWNER)
                .body(json!({"url":"wss://host/ws","uses":uses,"ttlSeconds":ttl}).to_string())
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    let (_, code) = fixture.invite(2, 86400).await;
    for name in ["", "bad\nname", &"x".repeat(33)] {
        assert_eq!(fixture.join(&code, name).await.status(), 401);
    }
    assert_eq!(
        fixture.join(&code, "é".repeat(32).as_str()).await.status(),
        200
    );
    assert_eq!(fixture.join(&code, "Second").await.status(), 200);
    assert_eq!(fixture.join(&code, "Third").await.status(), 401);
    for _ in 0..4 {
        assert_eq!(fixture.join("invalid", "Sam").await.status(), 401);
    }
    assert_eq!(fixture.join("invalid", "Sam").await.status(), 429);
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secrets_are_hashed_members_persist_and_plugins_cannot_address_host_space() {
    let fixture = Fixture::new().await;
    let (_, code) = fixture.invite(2, 86400).await;
    let response = fixture.join(&code, "Sam").await;
    let member: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let list = fixture
        .client()
        .get(format!("{}/members", fixture.local))
        .bearer_auth(OWNER)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(list.contains(member["memberId"].as_str().unwrap()));
    assert!(!list.contains("token"));
    assert_eq!(
        fixture
            .client()
            .get(format!("{}/members", fixture.local))
            .bearer_auth(member["token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let directory = fixture.close().await;
    let database = Database::open(Storage::Disk(directory.join("store")))
        .await
        .unwrap();
    let mut tx = database.read_only().await.unwrap();
    let members = tx
        .query(&Table::new("h__members").unwrap())
        .collect()
        .await
        .unwrap();
    let invites = tx
        .query(&Table::new("h__invites").unwrap())
        .collect()
        .await
        .unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(invites.len(), 1);
    assert_eq!(
        members[0].clone().into_json()["tokenHash"],
        format!(
            "{:x}",
            Sha256::digest(member["token"].as_str().unwrap().as_bytes())
        )
    );
    assert_eq!(
        invites[0].clone().into_json()["codeHash"],
        format!("{:x}", Sha256::digest(code.as_bytes()))
    );
    assert!(
        !json!([
            members[0].clone().into_json(),
            invites[0].clone().into_json()
        ])
        .to_string()
        .contains(member["token"].as_str().unwrap())
    );
    tx.commit().await.unwrap();
    let mut database = database;
    database.close().await.unwrap();
    assert_persisted_member(&directory, member["token"].as_str().unwrap()).await;
    std::fs::remove_dir_all(directory).unwrap();
}

async fn assert_persisted_member(directory: &std::path::Path, token: &str) {
    let database = Database::open(Storage::Disk(directory.join("store")))
        .await
        .unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Arc::new(
        Server::load_plugins(database, pool, &directory.join("plugins"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let stopping = stop.clone();
    let task = tokio::spawn(guest_listener::serve(
        listener,
        server.clone(),
        async move { stopping.cancelled().await },
    ));
    let socket = connect(&url, token).await.unwrap();
    drop(socket);
    stop.cancel();
    task.await.unwrap().unwrap();
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_connection_and_message_size_limits() {
    let fixture = Fixture::new().await;
    let member = fixture.member().await;
    let token = member["token"].as_str().unwrap();
    let mut sockets = Vec::new();
    for _ in 0..16 {
        sockets.push(fixture.socket(token).await);
    }
    assert!(connect(&fixture.guest, token).await.is_err());
    sockets[0]
        .send(Message::Text("x".repeat(16385).into()))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), sockets[0].next())
            .await
            .unwrap()
            .is_none_or(|message| message.is_err() || message.unwrap().is_close())
    );
    drop(sockets);
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_rate_limit_closes_a_burst() {
    let fixture = Fixture::new().await;
    let member = fixture.member().await;
    let mut socket = fixture.socket(member["token"].as_str().unwrap()).await;
    // Unsubscribe is cheap, so the burst cannot be slowed by JS execution.
    for id in 0..55 {
        if socket
            .feed(Message::Text(
                json!({"type":"unsubscribe","id":id}).to_string().into(),
            ))
            .await
            .is_err()
        {
            break;
        }
    }
    let _ = socket.flush().await;
    let count = tokio::time::timeout(Duration::from_secs(5), async {
        let mut count = 0;
        while let Some(Ok(message)) = socket.next().await {
            if message.is_text() {
                count += 1;
            } else if message.is_close() {
                break;
            }
        }
        count
    })
    .await
    .unwrap();
    assert!(count <= 50, "{count}");
    clean(fixture).await;
}

async fn cli(fixture: &Fixture, args: &[&str]) -> std::process::Output {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_tokamak"))
        .arg("member")
        .args(args)
        .env("TOKAMAK_SERVER_DIR", fixture.directory.path())
        .output()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn member_cli_uses_local_owner_controls() {
    let fixture = Fixture::new().await;
    let url = fixture.guest.replace("http:", "ws:") + "/ws";
    std::fs::write(
        fixture.directory.path().join("server.json"),
        json!({"url": fixture.local.replace("http:", "ws:") + "/ws"}).to_string(),
    )
    .unwrap();
    std::fs::write(fixture.directory.path().join("server.token"), OWNER).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            fixture.directory.path().join("server.token"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let output = cli(
        &fixture,
        &["invite", "--url", &url, "--uses", "2", "--ttl", "1h"],
    )
    .await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let link = reqwest::Url::parse(String::from_utf8(output.stdout).unwrap().trim()).unwrap();
    let pairs: BTreeMap<_, _> = link.query_pairs().into_owned().collect();
    assert_eq!(pairs["server"], url);
    let response = fixture.join(&pairs["code"], "Sam").await;
    let member: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let output = cli(&fixture, &["list"]).await;
    assert!(output.status.success());
    let members: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(members[0]["memberId"], member["memberId"]);
    assert_eq!(members[0]["name"], "Sam");
    assert!(members[0].get("tokenHash").is_none());
    let output = cli(&fixture, &["revoke", member["memberId"].as_str().unwrap()]).await;
    assert!(output.status.success());
    assert!(
        matches!(connect(&fixture.guest, member["token"].as_str().unwrap()).await, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 401)
    );
    assert!(
        !cli(&fixture, &["invite", "--url", &url, "--uses", "11"])
            .await
            .status
            .success()
    );
    assert!(
        !cli(&fixture, &["invite", "--url", &url, "--ttl", "8d"])
            .await
            .status
            .success()
    );
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invite_defaults_expiry_and_guest_subscription_identity() {
    let fixture = Fixture::new().await;
    let response = fixture
        .client()
        .post(format!("{}/members/invite", fixture.local))
        .bearer_auth(OWNER)
        .body(json!({"url":"wss://host/ws"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let link = reqwest::Url::parse(value["link"].as_str().unwrap()).unwrap();
    let code = link
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(fixture.join(&code, "Sam").await.status(), 200);
    assert_eq!(fixture.join(&code, "Other").await.status(), 401);
    let (_, expired) = fixture.invite(1, 1).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(fixture.join(&expired, "Late").await.status(), 401);
    let member = fixture.member().await;
    let mut socket = fixture.socket(member["token"].as_str().unwrap()).await;
    assert_eq!(
        call(&mut socket, "subscribe", "a/test:denied", json!({})).await["result"]["Err"],
        "Not available to guests"
    );
    let event = call(&mut socket, "subscribe", "a/test:identity", json!({})).await;
    assert_eq!(event["type"], "subscription");
    assert_eq!(event["result"]["Ok"]["memberId"], member["memberId"]);
    assert_eq!(event["result"]["Ok"]["role"], "guest");
    drop(socket);
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_tcp_connections_count_before_upgrade_and_expire() {
    use tokio::io::AsyncReadExt;
    let fixture = Fixture::new().await;
    let address = fixture.guest.trim_start_matches("http://");
    let mut sockets = Vec::new();
    for _ in 0..16 {
        sockets.push(TcpStream::connect(address).await.unwrap());
    }
    let mut excess = TcpStream::connect(address).await.unwrap();
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), excess.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(6), sockets[0].read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    drop(sockets);
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_authentication_is_limited_globally() {
    let fixture = Fixture::new().await;
    for _ in 0..10 {
        assert_eq!(
            fixture
                .client()
                .get(format!("{}/ws", fixture.guest))
                .bearer_auth("invalid")
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }
    assert_eq!(
        fixture
            .client()
            .get(format!("{}/ws", fixture.guest))
            .bearer_auth("different")
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_http_sizes_and_body_deadline_are_bounded() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = Fixture::new().await;
    assert_eq!(
        fixture
            .client()
            .post(format!("{}/join", fixture.guest))
            .body("x".repeat(16385))
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    let address = fixture.guest.trim_start_matches("http://");
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket
        .write_all(
            format!(
                "GET /ws HTTP/1.1\r\nHost: localhost\r\nX-Fill: {}",
                "x".repeat(20000)
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.read_to_end(&mut response))
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 431"));
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket
        .write_all(b"POST /join HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{")
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(6), socket.read(&mut [0]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    clean(fixture).await;
}

#[test]
fn legacy_bundle_cannot_be_shared_or_address_host_tables() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_tokamak"))
        .args(["--bundle", "missing.js", "--share", "127.0.0.1:0"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("legacy --bundle mode cannot be shared")
    );
    let host = Table::new("h__members").unwrap();
    for space in [
        server::data::DataSpace::default(),
        server::data::DataSpace::plugin("a").unwrap(),
    ] {
        assert!(space.table(&host).is_err());
        assert!(space.id("h__members:member").is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guest_errors_hide_stacks_and_paths_while_owners_keep_details() {
    let fixture = Fixture::new().await;
    let member = fixture.member().await;
    let mut guest = fixture.socket(member["token"].as_str().unwrap()).await;
    let mut owner = connect(&fixture.local, OWNER).await.unwrap();
    for kind in ["query", "subscribe"] {
        assert_eq!(
            call(&mut guest, kind, "a/test:failure", json!({})).await["result"]["Err"],
            "Public failure"
        );
    }
    assert_eq!(
        call(&mut guest, "action", "a/test:pathFailure", json!({})).await["result"]["Err"],
        "Cannot open [path]"
    );
    let error = call(&mut owner, "query", "a/test:failure", json!({})).await;
    assert!(
        error["result"]["Err"]
            .as_str()
            .unwrap()
            .contains("private /source/plugin.ts:10")
    );
    drop(guest);
    drop(owner);
    clean(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_data_is_unchanged_and_action_errors_use_the_invocation_snapshot() {
    let fixture = Fixture::new().await;
    let mut owner = connect(&fixture.local, OWNER).await.unwrap();
    assert_eq!(
        call(&mut owner, "query", "a/test:messageError", json!({})).await["result"]["Ok"],
        json!([{ "error":"failed: member-secret-do-not-echo", "text":"member-secret-do-not-echo" }])
    );
    let caught = call(&mut owner, "action", "a/test:caught", json!({})).await;
    assert!(
        caught["result"]["Ok"]["error"]
            .as_str()
            .unwrap()
            .contains("[redacted]")
    );
    assert!(!caught.to_string().contains("member-secret-do-not-echo"));
    let change = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        std::fs::write(
            fixture.directory.path().join(".env.local"),
            "MEMBER_TEST_SECRET=replacement-secret\n",
        )
        .unwrap();
    };
    let (error, ()) = tokio::join!(
        call(&mut owner, "action", "a/test:delayedSecret", json!({})),
        change
    );
    assert!(
        error["result"]["Err"]
            .as_str()
            .unwrap()
            .starts_with("[redacted]:[redacted]"),
        "{error}"
    );
    drop(owner);
    clean(fixture).await;
}
