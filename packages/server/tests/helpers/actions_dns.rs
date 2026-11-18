//! Each interposed resolver runs in its own process: no global DNS state leaks
//! into concurrent tests, and the parent watchdog also bounds broken teardown.
use super::*;
use std::time::Instant;

struct Resolver {
    directory: PathBuf,
}
impl Resolver {
    fn log(&self) -> PathBuf {
        self.directory.join("dns.log")
    }
    fn release(&self) {
        std::fs::write(self.directory.join("release"), "").unwrap();
    }
    fn entered(&self) -> usize {
        std::fs::read_to_string(self.log())
            .unwrap_or_default()
            .lines()
            .count()
    }
    async fn wait_for(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while self.entered() < count {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("fetch did not enter the real OS resolver");
    }
}
impl Drop for Resolver {
    fn drop(&mut self) {
        self.release();
    }
}

fn isolated(name: &str, test: impl AsyncFnOnce(&Resolver)) {
    if let Some(directory) = std::env::var_os("TKM45_DNS_CHILD") {
        let resolver = Resolver {
            directory: directory.into(),
        };
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(test(&resolver));
        return;
    }
    let installation = Installation::new();
    let artifact_cache = installation.0.join("artifacts.json");
    std::fs::write(&artifact_cache, serde_json::to_vec(artifacts()).unwrap()).unwrap();
    let library = installation.0.join("resolver.dylib");
    let mut compile = Command::new("cc");
    if cfg!(target_os = "macos") {
        compile.arg("-dynamiclib");
    } else {
        compile.args(["-shared", "-fPIC"]);
    }
    let output = compile
        .arg(root().join("packages/server/tests/fixtures/actions/resolver.c"))
        .arg("-o")
        .arg(&library)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = installation.0.join("stdout.log");
    let stderr = installation.0.join("stderr.log");
    let mut child = Child(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("dns::{name}"), "--nocapture"])
            .env("TKM45_DNS_CHILD", &installation.0)
            .env("TKM45_TEST_ARTIFACTS", artifact_cache)
            .env("TKM45_DNS_LOG", installation.0.join("dns.log"))
            .env("TKM45_DNS_RELEASE", installation.0.join("release"))
            .env("TKM45_TEST_CONNECT_LOG", installation.0.join("connect.log"))
            .env(
                if cfg!(target_os = "macos") {
                    "DYLD_INSERT_LIBRARIES"
                } else {
                    "LD_PRELOAD"
                },
                library,
            )
            .stdout(std::fs::File::create(&stdout).unwrap())
            .stderr(std::fs::File::create(&stderr).unwrap())
            .spawn()
            .unwrap(),
    );
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "{name}: child watchdog expired\n{}\n{}",
            std::fs::read_to_string(&stdout).unwrap(),
            std::fs::read_to_string(&stderr).unwrap()
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        status.success(),
        "{name}:\n{}\n{}",
        std::fs::read_to_string(stdout).unwrap(),
        std::fs::read_to_string(stderr).unwrap()
    );
}

fn pool() -> Pool {
    Pool::new_actions(PoolConfig {
        workers: 1,
        ..PoolConfig::default()
    })
    .unwrap()
}
fn fetch(pool: &Pool, count: usize, host: &str) -> engine::PendingCall {
    let bundle = Arc::new(Bundle::new(artifacts()["b/bundle.js"].clone(), None).unwrap());
    let mut ops = local_user_operations();
    ops.set_network_permissions(vec![format!("net:{host}")]);
    pool.submit(
        bundle,
        "invoke",
        json!({"name":"ops:dns","args":{"count":count,"host":host}}),
        Arc::new(ops),
    )
    .unwrap()
}
fn private_errors(result: &Value, count: usize) {
    let errors = result.as_array().unwrap();
    assert_eq!(errors.len(), count);
    for error in errors {
        assert_eq!(error["name"], "TypeError");
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("no permitted public addresses"),
            "{error}"
        );
    }
}
async fn finish(call: engine::PendingCall) -> Value {
    tokio::time::timeout(Duration::from_secs(3), call)
        .await
        .expect("DNS capacity did not recover")
        .unwrap()
}

// Prevent action cancellation and pool destruction from joining stuck OS DNS.
#[test]
fn teardown_does_not_wait_for_dns() {
    isolated("teardown_does_not_wait_for_dns", async |resolver| {
        let pool = pool();
        let pending = fetch(&pool, 1, "held.tkm.test");
        resolver.wait_for(1).await;
        let start = Instant::now();
        pool.cancel_actions();
        assert_eq!(pending.await.unwrap_err(), engine::Error::Closed);
        drop(pool);
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "teardown waited for DNS: {:?}",
            start.elapsed()
        );
        assert!(!resolver.directory.join("release").exists());
    });
}

// Prevent reload of a DNS-blocked generation from stalling normal transactions.
#[test]
fn plugin_reload_and_transactions_do_not_wait_for_dns() {
    isolated(
        "plugin_reload_and_transactions_do_not_wait_for_dns",
        async |resolver| {
            let installation = Installation::new();
            // The small b fixture isolates lifecycle latency from the AI SDK bundle.
            std::fs::remove_dir_all(installation.0.join("a")).unwrap();
            let database = Database::open(Storage::Memory).await.unwrap();
            let pool = Arc::new(
                Pool::new(PoolConfig {
                    workers: 1,
                    ..PoolConfig::default()
                })
                .unwrap(),
            );
            let server = Arc::new(
                Server::load_plugins(database, pool, &installation.0)
                    .await
                    .unwrap(),
            );
            let mut session = server.connect().await.unwrap();
            session
                .sender()
                .request(server::protocol::Request::Action {
                    id: 1,
                    name: "b/ops:dns".into(),
                    args: json!({"count":1,"host":"held.tkm.test"}),
                })
                .unwrap();
            resolver.wait_for(1).await;

            assert_transactions_during_dns(&mut session, 2).await;
            let start = Instant::now();
            let (reload, ()) = tokio::join!(
                server.reload_plugin("b".into()),
                assert_transactions_during_dns(&mut session, 4)
            );
            reload.unwrap();
            assert!(
                start.elapsed() < Duration::from_millis(200),
                "reload waited for DNS: {:?}",
                start.elapsed()
            );
            assert_transactions_during_dns(&mut session, 6).await;
            assert!(!resolver.directory.join("release").exists());
            drop(session);
            server.close().await.unwrap();
        },
    );
}

// Slow (fixed public 10 s deadline): prevent a forever-pending fetch or opaque Error.
#[test]
fn dns_timeout_is_a_clear_type_error() {
    isolated("dns_timeout_is_a_clear_type_error", async |resolver| {
        let pool = pool();
        let pending = fetch(&pool, 1, "held.tkm.test");
        resolver.wait_for(1).await;
        let start = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(12), pending)
            .await
            .expect("fetch never timed out")
            .unwrap();
        assert!(
            start.elapsed() >= Duration::from_secs(9),
            "resolver did not remain blocked until the DNS deadline"
        );
        assert_eq!(result[0]["name"], "TypeError");
        assert!(
            result[0]["message"]
                .as_str()
                .unwrap()
                .contains("DNS resolution timed out after 10 seconds"),
            "{result}"
        );
        assert_eq!(resolver.entered(), 1);
        assert!(!resolver.directory.join("release").exists());
        resolver.release();
        private_errors(&finish(fetch(&pool, 1, "held.tkm.test")).await, 1);
    });
}

// Prevent retired generations from bypassing the global cap or leaking permits.
#[test]
fn dns_capacity_is_bounded_across_generations_and_recovers() {
    isolated(
        "dns_capacity_is_bounded_across_generations_and_recovers",
        async |resolver| {
            for generation in 1..=4 {
                let pool = pool();
                let pending = fetch(&pool, 4, "held.tkm.test");
                resolver.wait_for(generation * 4).await;
                pool.cancel_actions();
                assert_eq!(pending.await.unwrap_err(), engine::Error::Closed);
                drop(pool);
            }
            let pool = pool();
            let mut pending = fetch(&pool, 32, "held.tkm.test");
            assert!(
                tokio::time::timeout(Duration::from_millis(200), &mut pending)
                    .await
                    .is_err(),
                "fetch unexpectedly completed with every resolver slot occupied"
            );
            assert_eq!(
                resolver.entered(),
                16,
                "stuck lookups spawned beyond the process-wide limit"
            );
            resolver.release();
            private_errors(&finish(pending).await, 32);
            assert_eq!(
                resolver.entered(),
                48,
                "all queued fetches must acquire recovered capacity"
            );
            private_errors(&finish(fetch(&pool, 1, "held.tkm.test")).await, 1);
            assert_eq!(resolver.entered(), 49);
        },
    );
}

// Prevent a hostname grant from granting access to its private DNS answer.
#[test]
fn dns_private_answer_still_refused() {
    isolated("dns_private_answer_still_refused", async |resolver| {
        let pool = pool();
        private_errors(&finish(fetch(&pool, 1, "private.tkm.test")).await, 1);
        assert!(
            !resolver.directory.join("connect.log").exists(),
            "private answer reached the connector"
        );
    });
}

async fn assert_transactions_during_dns(session: &mut server::Session, first: u64) {
    session
        .sender()
        .request(server::protocol::Request::Query {
            id: first,
            name: "b/ops:publicRead".into(),
            args: json!({}),
        })
        .unwrap();
    session
        .sender()
        .request(server::protocol::Request::Mutation {
            id: first + 1,
            name: "b/ops:privateWrite".into(),
            args: json!({}),
        })
        .unwrap();
    let mut seen = [false; 2];
    tokio::time::timeout(Duration::from_millis(200), async {
        while !seen.iter().all(|seen| *seen) {
            if let Event::Response { id, result } = session.recv().await.unwrap().unwrap() {
                if id == first {
                    assert_eq!(result.unwrap(), json!("public"));
                    seen[0] = true;
                } else if id == first + 1 {
                    assert!(result.unwrap().is_string());
                    seen[1] = true;
                }
            }
        }
    })
    .await
    .expect("transactions stalled behind DNS/reload");
}
