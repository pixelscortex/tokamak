#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::time::Duration;

use serde_json::json;
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{io::AsyncWriteExt, process::Command};

mod support;

use support::{Host, fixture};

#[tokio::test]
async fn json_from_plugin_code_preserves_fractional_payloads() {
    let mut host = Host::start();
    host.invoke(1, "parseJson", json!("{\"cost\":0.018920700000000002}"))
        .await;
    assert_eq!(
        host.receive().await["value"],
        json!({ "cost": 0.018920700000000002 })
    );
}

#[tokio::test]
async fn node_path_exports_posix_constants_by_name_and_on_its_default() {
    let mut host = Host::start();
    host.invoke(1, "pathConstants", json!(null)).await;
    assert_eq!(
        host.receive().await["value"],
        json!(["/", ":", "/", ":", "a/b", true, true])
    );
}

#[tokio::test]
async fn local_code_can_read_and_enumerate_the_launch_environment() {
    let mut host = Host::with_heap(Some("256"));
    host.invoke(1, "environment", json!("TOKAMAK_PLUGIN_HOST_HEAP_MIB"))
        .await;
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    assert_eq!(
        host.receive().await["value"],
        json!({
            "value": "256", "enumerable": true, "missing": true,
            "node": "undefined", "platform": platform, "ownPath": true, "hasPath": true,
        }),
    );
}

#[tokio::test]
async fn cancellation_rejects_only_its_operations_and_preserves_module_state() {
    let mut host = Host::start();
    host.invoke(1, "sleep", json!(3000)).await;
    host.invoke(2, "pending", json!({})).await;
    let pending = host.receive().await;
    assert_eq!(pending["name"], "local.runQuery");

    host.send(json!({ "type": "cancel", "id": 2 })).await;
    assert_eq!(
        host.receive().await,
        json!({
            "type": "result", "id": 2, "error": "Plugin local function cancelled"
        })
    );
    assert_eq!(host.receive().await["text"], "signal aborted");
    let listener_error = host.receive().await;
    assert_eq!(listener_error["level"], "error");
    assert!(
        listener_error["text"]
            .as_str()
            .unwrap()
            .contains("abort listener failed")
    );
    assert_eq!(
        host.receive().await["text"],
        "Plugin local function cancelled"
    );
    assert_eq!(
        host.receive().await["text"],
        "stale invocation: host operation refused"
    );
    host.send(json!({ "type": "opResult", "id": pending["id"], "value": null }))
        .await;

    assert_eq!(
        host.receive().await,
        json!({ "type": "result", "id": 1, "value": "slept" })
    );
    host.invoke(3, "counter", json!(null)).await;
    assert_eq!(host.receive().await["value"], 1);
}

#[tokio::test]
async fn an_invocation_can_wait_more_than_five_seconds() {
    let mut host = Host::start();
    host.invoke(1, "sleep", json!(7000)).await;
    assert_eq!(host.receive().await["value"], "slept");
}

#[tokio::test]
async fn watchdog_interrupts_a_tight_loop_and_retires_only_started_calls() {
    let mut host = Host::start();
    host.invoke(1, "sleep", json!(60000)).await;
    host.invoke(2, "loop", json!({})).await;
    assert_eq!(host.receive().await["text"], "loop");
    let started = std::time::Instant::now();
    host.send(json!({ "type": "cancel", "id": 2 })).await;
    host.send(json!({ "type": "invoke", "id": 3, "fn": "counter", "args": null }))
        .await;

    let mut results = [host.receive().await, host.receive().await];
    assert!((Duration::from_secs(4)..Duration::from_secs(8)).contains(&started.elapsed()));
    results.sort_by_key(|frame| frame["id"].as_u64().unwrap());
    assert_eq!(results[0]["id"], 1);
    assert_eq!(results[1]["id"], 2);
    for result in results {
        assert_eq!(
            result["error"],
            "Plugin local function did not yield for 5 seconds; QuickJS runtime reset"
        );
    }

    let op = host.receive().await;
    assert_eq!(op["call"], 3);
    assert_eq!(op["name"], "auth.current");
    host.send(json!({ "type": "opResult", "id": op["id"], "value": null }))
        .await;
    assert_eq!(host.receive().await["value"], 0);

    let number = json!(0.018920700000000002);
    host.invoke(4, "echo", number.clone()).await;
    assert_eq!(host.receive().await["value"], number);
}

#[tokio::test]
async fn allocation_failure_does_not_stop_another_call() {
    let mut host = Host::with_heap(Some("16"));
    host.send(json!({ "type": "invoke", "id": 1, "fn": "echo", "args": "still here" }))
        .await;
    let echo_op = host.receive().await;
    host.invoke(2, "memory", json!({})).await;
    assert_eq!(
        host.receive().await["error"],
        "Plugin local function ran out of memory"
    );

    host.send(json!({ "type": "opResult", "id": echo_op["id"], "value": null }))
        .await;
    assert_eq!(host.receive().await["value"], "still here");
}

#[tokio::test]
async fn oversized_output_fails_the_call_and_oversized_input_closes_the_host() {
    let mut host = Host::start();
    host.invoke(1, "huge", json!({})).await;
    assert_eq!(
        host.receive().await["error"],
        "Worker message exceeds 1 MiB limit"
    );

    host.input
        .write_all(&vec![b' '; WORKER_FRAME_BYTES])
        .await
        .unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(5), host.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(!exit.success());
}

#[tokio::test]
async fn local_functions_can_use_native_modules_timers_text_encoder_and_fetch() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let responder = std::thread::spawn(move || {
        use std::io::{BufRead, Write};
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = std::io::BufReader::new(&stream);
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nyes")
            .unwrap();
    });
    let mut host = Host::start();
    host.invoke(
        1,
        "native",
        json!({ "source": fixture(), "endpoint": endpoint }),
    )
    .await;
    let reply = host.receive().await;
    assert_eq!(
        reply["value"],
        json!({ "copied": true, "text": "yes", "bytes": [206, 181], "ticks": 1, "decoded": "ε" }),
        "{reply}"
    );
    responder.join().unwrap();
}

#[tokio::test]
async fn full_input_queue_waits_and_over_capacity_invocations_fail_individually() {
    let mut host = Host::start();
    host.invoke(201, "sleep", json!(500)).await;
    host.invoke(0, "busy", json!({})).await;
    assert_eq!(host.receive().await["text"], "busy");
    for id in 1..=200 {
        host.send(json!({ "type": "invoke", "id": id, "fn": "echo", "args": id }))
            .await;
    }
    assert_eq!(host.receive().await["value"], "finished");
    let mut ops = Vec::new();
    let mut rejected = 0;
    let mut timer = false;
    let mut id = 1;
    while id <= 200 || !timer {
        let frame = host.receive().await;
        if frame["type"] == "result" && frame["id"] == 201 {
            assert_eq!(frame["value"], "slept");
            // The driver may take a turn to wake the timer, but input cannot bury it.
            assert!(id <= 8, "timer starved behind {} frames", id - 1);
            timer = true;
            continue;
        }
        if id <= WORKER_CAPACITY {
            assert_eq!(frame["call"], id);
            ops.push(frame["id"].clone());
        } else {
            assert_eq!(frame["id"], id);
            assert_eq!(frame["error"], "Worker invocation capacity exceeded");
            rejected += 1;
        }
        id += 1;
    }
    assert_eq!(ops.len() + rejected, 200);
    for (index, op) in ops.into_iter().enumerate() {
        host.send(json!({ "type": "opResult", "id": op, "value": null }))
            .await;
        assert_eq!(host.receive().await["value"], index + 1);
    }
}

#[tokio::test]
async fn a_full_output_queue_does_not_stop_the_host_answering() {
    let mut host = Host::start();
    host.invoke(1, "flood", json!({})).await;

    // Nothing reads stdout here, so the plugin's log lines fill the queue.
    // A debug build needs most of a second to write them all.
    tokio::time::sleep(Duration::from_secs(2)).await;
    host.send(json!({ "type": "cancel", "id": 1 })).await;

    // Let the host handle the cancel while the queue is still full.
    tokio::time::sleep(Duration::from_millis(300)).await;

    loop {
        let frame = host.receive().await;
        if frame["type"] == "result" {
            assert_eq!(frame["id"], 1);
            assert_eq!(frame["error"], "Plugin local function cancelled");
            break;
        }
    }

    host.send(json!({ "type": "invoke", "id": 2, "fn": "echo", "args": "still here" }))
        .await;
    loop {
        let frame = host.receive().await;
        if frame["type"] == "op" {
            host.send(json!({ "type": "opResult", "id": frame["id"], "value": null }))
                .await;
        } else if frame["type"] == "result" {
            assert_eq!(frame["value"], "still here");
            break;
        }
    }
}

#[tokio::test]
async fn a_provider_path_never_loads_its_bundle_into_the_caller() {
    let mut host = Host::start();
    host.invoke(1, "providers", json!({})).await;
    let candidate_op = host.receive().await;
    assert_eq!(candidate_op["name"], "local.contracts");
    host.send(json!({
        "type": "opResult", "id": candidate_op["id"],
        "value": [{
            "plugin": "provider", "registration": "fixture", "path": fixture().with_file_name("provider.js"),
            "own": false, "owner": "consumer", "build": "provider-build", "dataMethods": true
        }]
    })).await;
    let auth = host.receive().await;
    assert_eq!(auth["name"], "auth.current");
    host.send(json!({ "type": "opResult", "id": auth["id"], "value": {} }))
        .await;
    let describe = host.receive().await;
    assert_eq!(describe["name"], "local.contract.describe", "{describe}");
    host.send(json!({
        "type": "opResult", "id": describe["id"],
        "value": {"data": {"id":"provider"}, "methods": ["run"]}
    }))
    .await;
    let call = host.receive().await;
    assert_eq!(call["name"], "local.contract.call", "{call}");
    assert_eq!(call["payload"]["args"], json!(["input"]));
    host.send(json!({ "type": "opResult", "id": call["id"], "value": "from provider" }))
        .await;
    assert_eq!(host.receive().await["value"], "from provider");
}

#[tokio::test]
async fn timer_capacity_is_reported_on_registration_and_interval_rearm() {
    let mut host = Host::start();
    host.invoke(1, "timerCapacity", json!(null)).await;
    assert!(
        host.receive().await["text"]
            .as_str()
            .unwrap()
            .contains("4096 live timers")
    );
    assert_eq!(
        host.receive().await["value"],
        "QuickJS timer capacity exceeded (4096 live timers)"
    );
}

#[tokio::test]
async fn invalid_heap_setting_names_the_variable() {
    let output = Command::new(env!("CARGO_BIN_EXE_tokamak-plugin-host"))
        .arg(fixture())
        .env("TOKAMAK_PLUGIN_HOST_HEAP_MIB", "0")
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("TOKAMAK_PLUGIN_HOST_HEAP_MIB must be a positive integer")
    );
}

#[tokio::test]
async fn filesystem_errors_carry_the_os_code_and_path() {
    let mut host = Host::start();
    let path = fixture().with_file_name("missing-file");
    host.invoke(1, "missing", json!(path)).await;
    assert_eq!(
        host.receive().await["value"],
        json!([["ENOENT", path], ["ENOENT", path], ["ENOENT", path]])
    );
}

#[tokio::test]
async fn filesystem_preserves_raw_paths_and_copies_links() {
    let mut host = Host::start();
    // APFS rejects invalid UTF-8 in filenames; Linux allows arbitrary bytes.
    let bytes: &[u8] = if cfg!(target_os = "macos") {
        "ε".as_bytes()
    } else {
        &[255]
    };
    host.invoke(1, "filesystem", json!(bytes)).await;
    let reply = host.receive().await;
    assert_eq!(
        reply["value"],
        json!({
            "path": "raw path", "mode": 384, "symlink": true, "contents": "target", "followed": true,
            "names": 3, "mtime": true, "exists": "ERR_FS_CP_EEXIST", "opened": "target",
            "unlinkDir": if cfg!(target_os = "macos") { "EPERM" } else { "EISDIR" },
        }),
        "{reply}"
    );
}

#[tokio::test]
async fn console_formats_placeholders_objects_errors_and_traces() {
    let mut host = Host::start();
    host.invoke(1, "console", json!(null)).await;
    assert_eq!(host.receive().await["text"], "value 2 {\"a\":1} [ 3, 4 ]");
    assert_eq!(
        host.receive().await["text"],
        "2 3.5 { nested: [ 4 ] }  tail"
    );
    assert_eq!(
        host.receive().await["text"],
        r#"1970-01-01T00:00:00.000Z Map(1) { "key" => 1 } Set(1) { 2 } Uint8Array(2) [ 3, 4 ]"#,
    );
    assert_eq!(host.receive().await["text"], "{ outer: [ 1, 2 ] }");
    assert!(
        host.receive().await["text"]
            .as_str()
            .unwrap()
            .contains("Trace: test")
    );
    let error = host.receive().await;
    assert!(error["text"].as_str().unwrap().contains("Error: broken\n"));
    assert_eq!(host.receive().await["text"].as_str().unwrap().len(), 8192);
    assert_eq!(host.receive().await["value"], true);
}

#[tokio::test]
async fn eof_and_shutdown_kill_the_host_process_group() {
    use std::os::unix::process::ExitStatusExt;
    for shutdown in [true, false] {
        let mut host = Host::start();
        let mut member = Command::new("/bin/sleep")
            .arg("60")
            .process_group(host.child.id().unwrap() as i32)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        if shutdown {
            host.send(json!({ "type": "shutdown" })).await;
        } else {
            drop(host.input);
        }
        let exit = tokio::time::timeout(Duration::from_secs(5), host.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(exit.success() || exit.signal() == Some(libc::SIGKILL));
        let member = tokio::time::timeout(Duration::from_secs(5), member.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(member.signal(), Some(libc::SIGKILL));
    }
}
