use super::*;

#[tokio::test]
async fn watchdog_interrupts_only_the_spinning_call_within_a_plugin() {
    let mut process = Process::start();
    process.invoke(1, 1, "loop", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["text"], "loop started");
    process.invoke(1, 2, "count", Value::Null, BUNDLE).await;
    let peer = tokio::time::timeout(Duration::from_secs(2), process.next())
        .await
        .expect("the spinning call stalled a peer call");
    assert_eq!(peer, json!({"type":"result","slot":1,"id":2,"value":1}));
    let failure = process.next().await;
    assert_eq!(failure["id"], 1);
    assert!(failure["error"].as_str().unwrap().contains("did not yield"));
    process.invoke(1, 3, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
}

#[tokio::test]
async fn heap_exhaustion_fails_only_the_owning_action() {
    let mut process = Process::start();
    process.invoke(1, 1, "heap", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["text"], "heap started");
    process.invoke(1, 2, "count", Value::Null, BUNDLE).await;
    let results = [process.next().await, process.next().await];
    assert!(
        results.contains(&json!({"type":"result","slot":1,"id":2,"value":1})),
        "{results:?}"
    );
    assert!(
        results
            .iter()
            .any(|frame| frame["id"] == 1 && frame["error"] == "Server action ran out of memory"),
        "{results:?}"
    );

    process.invoke(1, 3, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
}

#[tokio::test]
async fn returned_call_cannot_leave_self_rescheduling_promise_jobs() {
    let mut process = Process::start();
    process
        .invoke(1, 1, "orphanJobs", Value::Null, BUNDLE)
        .await;
    assert_eq!(process.next().await["value"], "returned");

    process.invoke(1, 2, "count", Value::Null, BUNDLE).await;
    let result = tokio::time::timeout(Duration::from_millis(750), process.next())
        .await
        .expect("an orphaned promise job stalled the next call");
    assert_eq!(result, json!({"type":"result","slot":1,"id":2,"value":1}));
}

#[tokio::test]
async fn returned_call_cannot_keep_allocating() {
    let mut process = Process::start();
    process.invoke(1, 1, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
    let before = rss_kib(&process.child);
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(BUNDLE);
    process
        .invoke_path(2, 2, "orphanAllocations", Value::Null, &path, 64)
        .await;
    assert_eq!(process.next().await["value"], "returned");

    tokio::time::sleep(Duration::from_millis(650)).await;
    let after = rss_kib(&process.child);
    assert!(
        after < before + 16 * 1024,
        "host RSS grew from {before} to {after} KiB"
    );
}

fn rss_kib(child: &Child) -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &child.id().unwrap().to_string()])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

#[tokio::test]
async fn sixty_four_calls_to_a_two_mib_bundle_all_succeed() {
    let bundle = large_bundle();
    let mut process = Process::start();
    for id in 1..=64 {
        process
            .invoke_path(1, id, "count", Value::Null, &bundle, 64)
            .await;
    }

    let mut ids = std::collections::BTreeSet::new();
    for _ in 0..64 {
        let result = process.next().await;
        assert_eq!(result["value"], 2 * 1024 * 1024, "{result}");
        assert!(ids.insert(result["id"].as_u64().unwrap()));
    }
    assert!(ids.into_iter().eq(1..=64));
    std::fs::remove_file(&bundle).unwrap();
    std::fs::remove_dir(bundle.parent().unwrap()).unwrap();
}

fn large_bundle() -> std::path::PathBuf {
    let directory =
        std::env::temp_dir().join(format!("tokamak-action-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("large.js");
    let data = "x".repeat(2 * 1024 * 1024);
    std::fs::write(
        &path,
        format!(
            r#"const data = "{data}"; export const functions = {{
            count: {{kind: "action", args: {{kind: "any"}}, invoke: () => data.length}}
        }};"#
        ),
    )
    .unwrap();
    path
}

#[tokio::test]
async fn anonymous_action_runs_during_sixty_four_signed_in_calls() {
    let mut process = Process::start();
    for id in 1..=64 {
        process.invoke(1, id, "hold", json!("held"), BUNDLE).await;
    }
    for _ in 0..64 {
        assert_eq!(process.next().await["text"], "held");
    }

    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(BUNDLE);
    process
        .send(json!({
            "type":"invoke","slot":1,"id":65,"fn":"count","args":null,
            "path":path,"permissions":[],"workerEntry":true,"heap":6 * 1024 * 1024,
            "network":false,
        }))
        .await;
    assert_eq!(
        process.next().await,
        json!({"type":"result","slot":1,"id":65,"value":1})
    );
}

#[tokio::test]
async fn completed_calls_keep_their_results_under_concurrency() {
    let mut process = Process::start();
    let batches = if cfg!(debug_assertions) {
        313
    } else {
        1250
    };
    let mut failures = 0;
    let mut first_failure = None;
    for batch in 0..batches {
        let first = batch * 16 + 1;
        for id in first..first + 16 {
            process.invoke(1, id, "count", Value::Null, BUNDLE).await;
        }

        let mut ids = std::collections::BTreeSet::new();
        for _ in 0..16 {
            let result = process.next().await;
            assert!(ids.insert(result["id"].as_u64().unwrap()));
            if result["value"] != 1 {
                failures += 1;
                first_failure.get_or_insert(result);
            }
        }
        assert!(ids.into_iter().eq(first..first + 16));
    }
    assert_eq!(failures, 0, "first failed result: {first_failure:?}");

    // Force the otherwise rare instruction-counter boundary after recording a
    // result, then also check that a subsequent throw cannot replace it.
    for (id, fail) in [(batches * 16 + 1, false), (batches * 16 + 2, true)] {
        process
            .invoke(1, id, "retireAtInterrupt", json!(fail), BUNDLE)
            .await;
        let log = process.next().await;
        assert_eq!(log["text"], "retired", "{log}");
        let result = process.next().await;
        assert_eq!(result["value"], "recorded", "{result}");
    }
}

#[tokio::test]
async fn call_threads_exit_after_success_throw_cancel_and_watchdog() {
    let mut process = Process::start();
    process.send(json!({"type":"ping","id":1})).await;
    assert_eq!(process.next().await["type"], "pong");
    let pid = process.child.id().unwrap();
    let baseline = thread_count(pid);

    for id in 1..=48 {
        let (name, args) = match id % 4 {
            0 => ("count", Value::Null),
            1 => ("throwValue", json!("null")),
            2 => ("hold", json!(id.to_string())),
            _ if id == 3 || id == 7 => ("loop", Value::Null),
            _ => ("count", Value::Null),
        };
        process.invoke(1, id, name, args, BUNDLE).await;
    }

    let mut received = 0;
    let mut cancelled = 0;
    while received + cancelled < 48 {
        let frame = process.next().await;
        match frame["type"].as_str().unwrap() {
            "result" => {
                let id = frame["id"].as_u64().unwrap();
                match id % 4 {
                    1 => assert_eq!(frame["error"], "Server action threw null"),
                    2 => panic!("cancelled call completed: {frame}"),
                    _ if id == 3 || id == 7 => {
                        assert!(frame["error"].as_str().unwrap().contains("did not yield"));
                    }
                    _ => assert_eq!(frame["value"], 1),
                }
                received += 1;
            }
            "log" if frame["text"] == "loop started" => {}
            "log" => {
                let id: u64 = frame["text"].as_str().unwrap().parse().unwrap();
                process
                    .send(json!({"type":"cancel","slot":1,"id":id}))
                    .await;
                cancelled += 1;
            }
            _ => panic!("unexpected frame: {frame}"),
        }
    }
    assert_eq!(cancelled, 12);

    let mut threads = thread_count(pid);
    tokio::time::timeout(Duration::from_secs(15), async {
        while threads != baseline {
            tokio::time::sleep(Duration::from_millis(25)).await;
            threads = thread_count(pid);
        }
    })
    .await
    .unwrap_or_else(|_| panic!("action process still has {threads} threads, baseline {baseline}"));
}

#[cfg(target_os = "linux")]
fn thread_count(pid: u32) -> usize {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .count()
}

#[cfg(target_os = "macos")]
fn thread_count(pid: u32) -> usize {
    let output = std::process::Command::new("ps")
        .args(["-M", "-p", &pid.to_string()])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().lines().count() - 1
}
