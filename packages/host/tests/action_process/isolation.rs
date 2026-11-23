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
async fn seventeenth_call_waits_in_order_and_can_be_cancelled() {
    let mut process = Process::start();
    for id in 1..=16 {
        process
            .invoke(1, id, "hold", json!(format!("held-{id}")), BUNDLE)
            .await;
    }
    for _ in 0..16 {
        assert!(
            process.next().await["text"]
                .as_str()
                .unwrap()
                .starts_with("held-")
        );
    }

    // Anonymous sign-in has a private slot but still shares the plugin's cap.
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(BUNDLE);
    process
        .send(json!({
            "type":"invoke","slot":2,"id":17,"fn":"hold","args":"seventeenth",
            "path":path,"permissions":[],"workerEntry":true,"heap":6 * 1024 * 1024,
            "pluginName":"1","network":false,
        }))
        .await;
    process
        .invoke(1, 18, "hold", json!("cancelled"), BUNDLE)
        .await;
    process
        .invoke(1, 19, "hold", json!("nineteenth"), BUNDLE)
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), process.next())
            .await
            .is_err()
    );

    process
        .send(json!({"type":"cancel","slot":1,"id":18}))
        .await;
    process.send(json!({"type":"cancel","slot":1,"id":1})).await;
    assert_eq!(process.next().await["text"], "seventeenth");
    process.send(json!({"type":"cancel","slot":1,"id":2})).await;
    assert_eq!(process.next().await["text"], "nineteenth");
}
