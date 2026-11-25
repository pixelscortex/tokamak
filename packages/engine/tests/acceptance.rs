//! TKM-2 acceptance tests exercise public APIs with real QuickJS, not an engine mock.
//! Gates establish concurrency ordering; a subprocess watchdog contains runaway JS.

use engine::{
    Bundle, Engine, Error, Invocation, Json, Limits, OpRegistry, Pool, PoolConfig, QuickJsContext,
    QuickJsEngine, install_ops,
};
use serde_json::json;
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(10), future)
                .await
                .expect("acceptance test exceeded outer timeout")
        })
}

fn bundle(source: &str) -> Arc<Bundle> {
    Arc::new(Bundle::new(source, None).unwrap())
}

fn pool(workers: usize, queue_capacity: usize, limits: Limits) -> Pool {
    Pool::new(PoolConfig {
        workers,
        queue_capacity,
        limits,
    })
    .unwrap()
}

async fn invoke(
    pool: &Pool,
    source: &str,
    export: &str,
    args: Json,
    ops: Arc<OpRegistry>,
) -> Result<Json, Error> {
    pool.submit(bundle(source), export, args, ops)
        .unwrap()
        .await
}

fn no_ops() -> Arc<OpRegistry> {
    Arc::new(OpRegistry::new())
}

// Purpose: the small Engine boundary accepts bundled ESM and preserves JSON across
// synchronous and asynchronous exports without callers handling engine values.
#[test]
fn esm_json_exports_through_engine_boundary() {
    run(async {
        let mut engine = QuickJsEngine::new(Limits::default()).unwrap();
        let input = json!({"text":"こんにちは 🧪", "nested":[null,true,false,3.25, {"empty":[]} ]});
        assert_eq!(
            invoke_export(&mut engine, "sync", input.clone())
                .await
                .unwrap(),
            json!({"tag":"bundled", "x":input})
        );
        for value in [
            json!(null),
            json!(false),
            json!(42),
            json!("text"),
            json!([]),
            input,
        ] {
            assert_eq!(
                invoke_export(&mut engine, "asynchronous", value.clone())
                    .await
                    .unwrap(),
                value
            );
        }
    });
}

// Purpose: malformed bundles, missing/nonfunction exports, thrown/rejected errors,
// and non-JSON results must fail clearly instead of looking like successful nulls.
#[test]
fn invocation_errors_are_not_successful_json() {
    run(async {
        let pool = pool(1, 1, Limits::default());
        for (source, export, message) in [
            ("export function broken( {", "broken", None),
            ("export const value = 1;", "missing", Some("missing")),
            ("export const value = 1;", "value", Some("not a function")),
            (
                "export function fail(){ throw new Error('sync sentinel'); }",
                "fail",
                Some("sync sentinel"),
            ),
            (
                "export async function fail(){ throw new Error('async sentinel'); }",
                "fail",
                Some("async sentinel"),
            ),
            (
                "export function fail(){ return undefined; }",
                "fail",
                Some("JSON"),
            ),
            (
                "export function fail(){ return 1n; }",
                "fail",
                Some("BigInt"),
            ),
            (
                "export function fail(){ const x = {}; x.self = x; return x; }",
                "fail",
                Some("circular"),
            ),
        ] {
            let error = invoke(&pool, source, export, json!(null), no_ops())
                .await
                .expect_err(source);
            assert!(
                matches!(&error, Error::JavaScript { message, .. } if !message.trim().is_empty()),
                "expected a clear JS diagnostic for {source}: {error}"
            );
            if let Some(message) = message {
                assert!(error.to_string().contains(message), "{error}");
            }
        }
        assert_eq!(
            invoke(
                &pool,
                "export function ok(x){return x}",
                "ok",
                json!("still usable"),
                no_ops()
            )
            .await
            .unwrap(),
            json!("still usable")
        );
    });
}

// Purpose: registry ops retain their sync/value or async/Promise semantics, JSON
// payloads, and catchable errors; duplicate registration cannot replace authority.
#[test]
fn host_registry_sync_async_errors_and_json() {
    run(async {
        let mut ops = OpRegistry::new();
        ops.register_sync("echo", Ok).unwrap();
        assert!(matches!(
            ops.register_sync("echo", |_| Ok(json!("replacement"))),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(
            ops.register_sync("", Ok),
            Err(Error::InvalidInput(_))
        ));
        ops.register_async("asyncEcho", |value| async move {
            tokio::task::yield_now().await;
            Ok(value)
        })
        .unwrap();
        ops.register_sync("syncFail", |_| Err("sync host sentinel".into()))
            .unwrap();
        ops.register_async("asyncFail", |_| async { Err("async host sentinel".into()) })
            .unwrap();
        let result = invoke(
            &pool(1, 1, Limits::default()),
            HOST_REGISTRY_SYNC_ASYNC_ERRORS_AND_JSON_SOURCE,
            "invoke",
            json!({"a":[1,null,"🦀"]}),
            Arc::new(ops),
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            json!({"sync":{"a":[1,null,"🦀"]},"async":{"a":[1,null,"🦀"]},"syncIsPromise":false,"asyncIsPromise":true,"errors":["unknown host op: absent","sync host sentinel","async host sentinel"],"invalidArgument":true})
        );
    });
}

// Purpose: an occupied worker and a full waiting queue reject admission immediately;
// a second real JS worker runs concurrently, and admitted calls retain their args.
#[test]
fn real_workers_are_concurrent_and_queue_is_bounded() {
    let pool = pool(
        2,
        1,
        Limits {
            call_timeout: Duration::from_secs(5),
            ..Limits::default()
        },
    );
    let (entered_tx, entered_rx) = mpsc::channel();
    let mut ops = OpRegistry::new();
    ops.register_async("gate", move |args| {
        let (release, wait) = tokio::sync::oneshot::channel();
        entered_tx.send((args.clone(), release)).unwrap();
        async move {
            wait.await.map_err(|_| "gate closed".to_owned())?;
            Ok(args)
        }
    })
    .unwrap();
    let ops = Arc::new(ops);
    let code = bundle("export async function invoke(x, host){ return await host.op('gate', x); }");
    let first = pool
        .submit(code.clone(), "invoke", json!(1), ops.clone())
        .unwrap();
    let (id1, release1) = entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(id1, json!(1));
    let second = pool
        .submit(code.clone(), "invoke", json!(2), ops.clone())
        .unwrap();
    let (id2, release2) = entered_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("second worker must enter while first is gated");
    assert_eq!(id2, json!(2));
    let queued = pool
        .submit(code.clone(), "invoke", json!(3), ops.clone())
        .unwrap();
    assert!(matches!(
        pool.submit(code, "invoke", json!(4), ops),
        Err(Error::Overloaded)
    ));
    release1.send(()).unwrap();
    assert_eq!(run(first).unwrap(), json!(1));
    let (id3, release3) = entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(id3, json!(3));
    release2.send(()).unwrap();
    release3.send(()).unwrap();
    assert_eq!(run(second).unwrap(), json!(2));
    assert_eq!(run(queued).unwrap(), json!(3));
}

// Purpose: retained bridge closures cannot acquire a new invocation's authority,
// whether the original lease was retired, dropped, or is already past deadline.
#[test]
fn stale_sync_bridges_refuse_host_entry() {
    run(async {
        let world = QuickJsContext::new(8 * 1024 * 1024).await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = OpRegistry::new();
        let count = calls.clone();
        registry
            .register_sync("touch", move |_| {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(json!(true))
            })
            .unwrap();
        let registry = Arc::new(registry);
        world
            .context()
            .with(|ctx| {
                let old = Invocation::new(Instant::now() + Duration::from_secs(5));
                ctx.globals()
                    .set("old", install_ops(&ctx, registry.clone(), &old).unwrap())
                    .unwrap();
                old.retire();
                let dropped = Invocation::new(Instant::now() + Duration::from_secs(5));
                ctx.globals()
                    .set(
                        "dropped",
                        install_ops(&ctx, registry.clone(), &dropped).unwrap(),
                    )
                    .unwrap();
                drop(dropped);
                let expired = Invocation::new(Instant::now());
                ctx.globals()
                    .set(
                        "expired",
                        install_ops(&ctx, registry.clone(), &expired).unwrap(),
                    )
                    .unwrap();
                let current = Invocation::new(Instant::now() + Duration::from_secs(5));
                ctx.globals()
                    .set("current", install_ops(&ctx, registry, &current).unwrap())
                    .unwrap();
                let refused: bool = ctx
                    .eval(
                        r#"[old, dropped, expired].every(h => {
                try { h.op('touch', null); return false; }
                catch(e) { return e.message.includes('stale invocation'); }
            }) && current.op('touch', null) === true"#,
                    )
                    .unwrap();
                assert!(refused);
            })
            .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    });
}

// Purpose: retiring an invocation with a polled host future prevents further host
// polling even when another live lease is installed in the same QuickJS context.
#[test]
fn stale_async_continuation_is_refused_before_repolling_host() {
    run(async {
        let world = QuickJsContext::new(8 * 1024 * 1024).await.unwrap();
        let polls = Arc::new(AtomicUsize::new(0));
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let (entered, mut started) = tokio::sync::oneshot::channel::<()>();
        let wait = Arc::new(std::sync::Mutex::new(Some((wait, entered))));
        let mut registry = OpRegistry::new();
        let observed = polls.clone();
        registry
            .register_async("wait", move |_| {
                let (wait, entered) = wait.lock().unwrap().take().unwrap();
                let observed = observed.clone();
                async move { wait_for_host_release(wait, entered, observed).await }
            })
            .unwrap();
        world
            .context()
            .async_with(async |ctx| {
                let old = Invocation::new(Instant::now() + Duration::from_secs(5));
                ctx.globals()
                    .set("old", install_ops(&ctx, Arc::new(registry), &old).unwrap())
                    .unwrap();
                let promise: engine::rquickjs::Promise = ctx.eval("old.op('wait', null)").unwrap();
                let mut result = Box::pin(promise.into_future::<engine::rquickjs::Value>());
                // Yield to the context's job scheduler until the host actually polls;
                // merely polling a JS Promise once does not start Rust host futures.
                std::future::poll_fn(|cx| {
                    assert!(result.as_mut().poll(cx).is_pending());
                    std::pin::Pin::new(&mut started).poll(cx)
                })
                .await
                .unwrap();
                let polls_before_retirement = polls.load(Ordering::SeqCst);
                assert!(polls_before_retirement > 0);
                old.retire();
                let current = Invocation::new(Instant::now() + Duration::from_secs(5));
                ctx.globals()
                    .set("current", install_ops(&ctx, no_ops(), &current).unwrap())
                    .unwrap();
                release.send(()).unwrap();
                assert!(result.await.is_err());
                let thrown = ctx.catch();
                let message: String = thrown.as_object().unwrap().get("message").unwrap();
                assert!(message.contains("stale invocation"), "{message}");
                assert_eq!(
                    polls.load(Ordering::SeqCst),
                    polls_before_retirement,
                    "retired host future was polled again"
                );
            })
            .await;
    });
}

// Purpose: a buggy interrupt or heap limiter must fail this test, not wedge the
// whole test suite. Only the subprocess runs nonterminating/allocation-heavy JS.
#[test]
fn resource_limits_have_a_process_watchdog() {
    use std::process::{Command, Stdio};
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "resource_limits_child",
            "--nocapture",
        ])
        .env("TKM2_RESOURCE_CHILD", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "resource-limit child exceeded 20s watchdog\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        // Watchdog polling only; test ordering never depends on a sleep.
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "resource-limit child failed: {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

// Purpose: enforce load/call time and heap budgets with real QuickJS, including
// pending promises/microtask loops, and prove the same one-worker pool recovers.
#[test]
#[ignore = "executed by resource_limits_have_a_process_watchdog in a subprocess"]
fn resource_limits_child() {
    assert!(
        std::env::var_os("TKM2_RESOURCE_CHILD").is_some(),
        "run resource_limits_have_a_process_watchdog instead; this child needs its process watchdog"
    );
    run(async {
        let limits = Limits {
            heap_bytes: 8 * 1024 * 1024,
            load_timeout: Duration::from_millis(250),
            call_timeout: Duration::from_millis(250),
        };
        let pool = pool(1, 1, limits);
        for (name, source, phase) in [
            (
                "load bytecode loop",
                "while(true){} export function invoke(){}",
                Some("load"),
            ),
            (
                "unresolved top-level await",
                "await new Promise(()=>{}); export function invoke(){}",
                Some("load"),
            ),
            (
                "call bytecode loop",
                "export function invoke(){while(true){}}",
                Some("call"),
            ),
            (
                "unresolved call promise",
                "export function invoke(){return new Promise(()=>{})}",
                Some("call"),
            ),
            (
                "endless microtasks",
                "export async function invoke(){while(true){await Promise.resolve()}}",
                Some("call"),
            ),
            (
                "load heap cap",
                "const x = new ArrayBuffer(64 * 1024 * 1024); export function invoke(){return x.byteLength}",
                None,
            ),
            (
                "call heap cap",
                "export function invoke(){return new ArrayBuffer(64 * 1024 * 1024).byteLength}",
                None,
            ),
        ] {
            let error = invoke(&pool, source, "invoke", json!(null), no_ops())
                .await
                .expect_err(name);
            if let Some(phase) = phase {
                assert_eq!(error, Error::Timeout { phase }, "{name}");
            } else {
                assert!(
                    matches!(error, Error::JavaScript { .. } | Error::Engine(_)),
                    "{name}: {error}"
                );
                let diagnostic = error.to_string().to_lowercase();
                assert!(
                    diagnostic.contains("memory") || diagnostic.contains("allocation"),
                    "heap cap failure must identify the allocation problem, not an unrelated error: {error}"
                );
            }
            assert_eq!(
                invoke(
                    &pool,
                    "export function invoke(x){return x}",
                    "invoke",
                    json!(name),
                    no_ops()
                )
                .await
                .unwrap(),
                json!(name),
                "worker did not recover after {name}"
            );
        }
    });
}

// Purpose: real bundler maps must identify the throwing TS line rather than the
// preceding await, for both multiline and first-line minified Unicode bundles.
#[test]
fn bundled_typescript_errors_report_original_file_and_line() {
    run(async {
        let pool = pool(1, 1, Limits::default());
        for (source, map) in [
            (
                include_str!("fixtures/mapped.js"),
                include_str!("fixtures/mapped.js.map"),
            ),
            (
                include_str!("fixtures/mapped.min.js"),
                include_str!("fixtures/mapped.min.js.map"),
            ),
        ] {
            let mapped = Arc::new(Bundle::new(source, Some(map)).unwrap());
            let error = pool
                .submit(mapped, "invoke", json!({"id":7}), no_ops())
                .unwrap()
                .await
                .unwrap_err();
            let Error::JavaScript {
                message,
                stack: Some(stack),
            } = error
            else {
                panic!("missing JS diagnostic: {error:?}");
            };
            assert_eq!(message, "missing todo: 作業 🧪 7");
            assert!(
                stack.contains("mapped.ts:9:"),
                "wrong original throwing line: {stack}"
            );
            assert!(
                !stack.contains("tokamak-bundle.js:"),
                "bundle frame was not mapped: {stack}"
            );
            let unmapped = pool
                .submit(bundle(source), "invoke", json!({"id":7}), no_ops())
                .unwrap()
                .await
                .unwrap_err();
            assert!(
                unmapped.to_string().contains("tokamak-bundle.js:"),
                "unmapped diagnostic lost generated location: {unmapped}"
            );
        }
    });
}

async fn assert_startup_location(source: &str, map: &str, expected: &str) {
    let bundle = Bundle::new(source, Some(map)).unwrap();
    let mut engine = QuickJsEngine::new(Limits::default()).unwrap();
    let error = engine
        .invoke(&bundle, "invoke", json!(null), no_ops())
        .await
        .expect_err("the startup global is deliberately undefined");
    let Error::JavaScript {
        message,
        stack: Some(stack),
    } = error
    else {
        panic!("missing module-load JS diagnostic: {error:?}");
    };
    assert_eq!(message, "初始化 is not defined");
    // Include the frame delimiter so column 3 cannot accidentally match 30.
    assert!(
        stack.contains(&format!("{expected})")),
        "expected original {expected}, got:\n{stack}"
    );
    assert!(
        !stack.contains("tokamak-bundle.js:"),
        "module-load bundle frame was not mapped: {stack}"
    );
}

// Purpose: a module-load error at the first Unicode token of a real minified
// bundle must identify the original TS file, line, and column, not stay generated.
#[test]
fn unicode_first_token_load_error_reports_original_typescript_location() {
    run(assert_startup_location(
        include_str!("fixtures/first-token.js"),
        include_str!("fixtures/first-token.js.map"),
        "first-token.ts:3:1",
    ));
}

// Purpose: Unicode identifier mapping must also work after a generated binding
// prefix, preserving the original indented initializer's TS line and column.
#[test]
fn unicode_initializer_load_error_reports_original_typescript_location() {
    run(assert_startup_location(
        include_str!("fixtures/startup.js"),
        include_str!("fixtures/startup.js.map"),
        "startup.ts:3:3",
    ));
}

// Purpose: when first-line source-map interpretations disagree on the original
// line, report uncertainty and retain the generated frame instead of confidently
// blaming the array's closing bracket rather than its missing initializer.
#[test]
fn array_initializer_mapping_reports_ambiguity_without_losing_evidence() {
    run(async {
        let source = include_str!("fixtures/array-initializer.js");
        let map = include_str!("fixtures/array-initializer.js.map");
        // Establish the ambiguity from real bundler metadata, independently of
        // the runtime's choice of generated-column interpretation.
        let decoded = sourcemap::SourceMap::from_reader(map.as_bytes()).unwrap();
        for (generated_column, original_line, original_column) in [(7, 2, 2), (8, 3, 0)] {
            let token = decoded.lookup_token(0, generated_column).unwrap();
            assert_eq!(token.get_source(), Some("array-initializer.ts"));
            assert_eq!(
                (token.get_src_line(), token.get_src_col()),
                (original_line, original_column)
            );
        }
        let bundle = Bundle::new(source, Some(map)).unwrap();
        let mut engine = QuickJsEngine::new(Limits::default()).unwrap();
        let error = engine
            .invoke(&bundle, "invoke", json!(null), no_ops())
            .await
            .unwrap_err();
        assert!(
            matches!(&error, Error::JavaScript { message, .. } if message.contains("x is not defined")),
            "expected missing-initializer diagnostic: {error}"
        );
        let diagnostic = error.to_string();
        assert!(
            diagnostic.contains("array-initializer.ts:3:"),
            "ambiguous diagnostic must include the actual initializer's original line, not only the closing bracket:\n{diagnostic}"
        );
        let wording = diagnostic.to_lowercase();
        assert!(
            wording.contains("ambig")
                || wording.contains("possible source locations")
                || wording.contains("possible locations"),
            "conflicting original locations must be explicitly labeled as ambiguous:\n{diagnostic}"
        );
        assert!(
            diagnostic.contains("tokamak-bundle.js:1:8"),
            "ambiguous mapping must retain the generated frame as evidence:\n{diagnostic}"
        );
    });
}

// Purpose: invalid source-map metadata must be a load-input error, not silently
// accepted with falsely reassuring generated-only developer diagnostics.
#[test]
fn malformed_source_map_is_rejected() {
    assert!(
        matches!(Bundle::new("export function invoke(){}", Some("not a source map")), Err(Error::InvalidInput(message)) if message.contains("source map"))
    );
}

struct DropNotice(Arc<AtomicUsize>);

impl Drop for DropNotice {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

// Purpose: detached host futures must be disposed before either a successful or
// exceptional reply; finishing the main export cannot leave late host work alive.
#[test]
fn detached_host_future_is_dropped_before_success_or_exception_reply() {
    run(async {
        let pool = pool(1, 1, Limits::default());
        for outcome in ["return 'done';", "throw new Error('done with error');"] {
            let dropped = Arc::new(AtomicUsize::new(0));
            let (entered, started) = tokio::sync::oneshot::channel::<()>();
            let entered = Arc::new(std::sync::Mutex::new(Some(entered)));
            let started = Arc::new(std::sync::Mutex::new(Some(started)));
            let mut ops = OpRegistry::new();
            let notice = dropped.clone();
            ops.register_async("wait", move |_| {
                let notice = DropNotice(notice.clone());
                let entered = entered.lock().unwrap().take().unwrap();
                async move {
                    let _notice = notice;
                    entered.send(()).unwrap();
                    std::future::pending::<Result<Json, String>>().await
                }
            })
            .unwrap();
            ops.register_async("started", move |_| {
                let started = started.lock().unwrap().take().unwrap();
                async move {
                    started.await.map_err(|e| e.to_string())?;
                    Ok(json!(null))
                }
            })
            .unwrap();
            let source = format!(
                "export async function invoke(_,host){{ void host.op('wait',null); await host.op('started',null); {outcome} }}"
            );
            let result = invoke(&pool, &source, "invoke", json!(null), Arc::new(ops)).await;
            if outcome.starts_with("return") {
                assert_eq!(result.unwrap(), json!("done"));
            } else {
                assert!(result.unwrap_err().to_string().contains("done with error"));
            }
            assert_eq!(
                dropped.load(Ordering::SeqCst),
                1,
                "detached host resources survived {outcome}"
            );
        }
    });
}

// Purpose: timing out a never-ready host future must dispose its captured host
// resources before replying, and must not poison the next call on that worker.
#[test]
fn unresolved_host_future_is_dropped_before_timeout_reply() {
    run(async {
        let dropped = Arc::new(AtomicUsize::new(0));
        let polls = Arc::new(AtomicUsize::new(0));
        let mut ops = OpRegistry::new();
        let notice = dropped.clone();
        let observed = polls.clone();
        ops.register_async("wait", move |_| {
            let notice = DropNotice(notice.clone());
            let observed = observed.clone();
            async move {
                let _notice = notice;
                std::future::poll_fn(|_| {
                    observed.fetch_add(1, Ordering::SeqCst);
                    std::task::Poll::<Result<Json, String>>::Pending
                })
                .await
            }
        })
        .unwrap();
        let pool = pool(
            1,
            1,
            Limits {
                call_timeout: Duration::from_millis(250),
                ..Limits::default()
            },
        );
        let result = invoke(
            &pool,
            "export async function invoke(_,host){ return await host.op('wait', null) }",
            "invoke",
            json!(null),
            Arc::new(ops),
        )
        .await;
        assert_eq!(result, Err(Error::Timeout { phase: "call" }));
        assert!(
            polls.load(Ordering::SeqCst) > 0,
            "host future never started"
        );
        assert_eq!(
            dropped.load(Ordering::SeqCst),
            1,
            "host resources survived reply"
        );
        assert_eq!(
            invoke(
                &pool,
                "export function invoke(){return 'recovered'}",
                "invoke",
                json!(null),
                no_ops()
            )
            .await
            .unwrap(),
            json!("recovered")
        );
    });
}

const HOST_REGISTRY_SYNC_ASYNC_ERRORS_AND_JSON_SOURCE: &str = r#"
            export async function invoke(input, host) {
                const sync = host.op('echo', input);
                const pending = host.op('asyncEcho', input);
                const errors = [];
                for (const name of ['absent', 'syncFail', 'asyncFail']) {
                    try { await host.op(name, null); } catch (e) { errors.push(e.message); }
                }
                let invalidArgument = false;
                try { host.op('echo', 1n); } catch (_) { invalidArgument = true; }
                return {sync, async: await pending, syncIsPromise: sync instanceof Promise,
                    asyncIsPromise: pending instanceof Promise, errors, invalidArgument};
            }
        "#;

async fn invoke_export(engine: &mut impl Engine, export: &str, args: Json) -> Result<Json, Error> {
    engine.invoke(&Bundle::new("const tag = 'bundled'; export function sync(x) { return {tag, x}; } export async function asynchronous(x) { await Promise.resolve(); return x; }", None).unwrap(), export, args, no_ops()).await
}

async fn wait_for_host_release(
    mut wait: tokio::sync::oneshot::Receiver<()>,
    entered: tokio::sync::oneshot::Sender<()>,
    observed: Arc<AtomicUsize>,
) -> Result<Json, String> {
    let mut entered = Some(entered);
    std::future::poll_fn(|cx| {
        observed.fetch_add(1, Ordering::SeqCst);
        if let Some(entered) = entered.take() {
            entered.send(()).unwrap();
        }
        std::pin::Pin::new(&mut wait).poll(cx)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!("must not resolve"))
}

#[test]
fn stage_bundles_share_state_within_a_call_and_replay_from_a_fresh_world() {
    use engine::{CallFuture, CallTransforms, Determinism, ModuleCall, StageExecutor};

    struct Stages(Arc<Bundle>);

    impl CallTransforms for Stages {
        fn before<'a>(&'a self, executor: &'a dyn StageExecutor, _: Json) -> CallFuture<'a> {
            Box::pin(async move {
                let call = || {
                    ModuleCall::new(
                        self.0.clone(),
                        "stage",
                        Json::Null,
                        Arc::new(OpRegistry::new()),
                        drop,
                    )
                };
                let first = executor.run(call(), true).await?;
                let second = executor.run(call(), true).await?;
                Ok(json!([first, second]))
            })
        }

        fn after<'a>(&'a self, _: &'a dyn StageExecutor, _: Json, value: Json) -> CallFuture<'a> {
            Box::pin(async move { Ok(value) })
        }
    }

    run(async {
        let pool = pool(1, 4, Limits::default());
        let stage = bundle(
            "let n = 0; export function stage() { return [++n, Date.now(), Math.random()]; }",
        );
        let mut ops = OpRegistry::new();
        ops.set_determinism(Determinism {
            timestamp_ms: 42,
            seed: 123,
        });
        let ops = Arc::new(ops.with_transforms(Stages(stage)));
        let call = || {
            invoke(
                &pool,
                "export function read(value) { return value; }",
                "read",
                Json::Null,
                ops.clone(),
            )
        };

        let first = call().await.unwrap();
        assert_eq!(first[0][0], 1);
        assert_eq!(first[1][0], 2);
        assert_eq!(first[0][1], 42);
        assert_eq!(first[1][1], 42);
        assert_ne!(first[0][2], first[1][2]);
        assert_eq!(call().await.unwrap(), first);
    });
}
