#![cfg(any(target_os = "linux", target_os = "macos"))]

mod support;

use std::{collections::BTreeMap, future::pending, process::Stdio, time::Duration};

use serde_json::{Value, json};
use support::{Host, fixture};
use tokamak_worker::{LocalRuntime, Process};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::UnixDatagram,
    process::Command,
    time::{Instant, sleep, timeout},
};

fn tree_path() -> std::path::PathBuf {
    fixture().with_file_name("program-tree.sh")
}

fn pids(value: Value) -> [i32; 4] {
    let pids: [i32; 4] = serde_json::from_value(value).unwrap();
    assert!(pids.iter().all(|&pid| pid > 1), "{pids:?}");
    pids
}

fn logged_tree(frame: Value) -> [i32; 4] {
    let text = frame["text"].as_str().unwrap();
    let ids = text.strip_prefix("tree ").unwrap().split_whitespace();
    let ids: Vec<i32> = ids.map(|pid| pid.parse().unwrap()).collect();
    pids(json!(ids))
}

fn reap_orphans_on_linux() {
    // In containers PID 1 need not reap orphans. Adopt these fixtures so
    // kill(pid, 0) also verifies that the dead processes have been reaped.
    #[cfg(target_os = "linux")]
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );
}

async fn assert_gone(pids: &[i32]) {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let alive: Vec<_> = pids
            .iter()
            .copied()
            .filter(|&pid| {
                // SAFETY: These are positive PIDs reported by the fixture. Reap
                // adopted children if they exited; waitpid does not block.
                #[cfg(target_os = "linux")]
                unsafe {
                    libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
                }
                let result = unsafe { libc::kill(pid, 0) };
                result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
            })
            .collect();
        if alive.is_empty() {
            return;
        }
        assert!(
            Instant::now() < end,
            "Still present after cleanup: {alive:?}"
        );
        sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn stop_lets_the_program_handle_term() {
    let mut host = Host::start();
    host.invoke(1, "graceful", Value::Null).await;
    assert_eq!(
        host.receive().await["value"],
        json!([["ready", "stopped"], 42])
    );
}

#[tokio::test]
async fn routed_result_arrives_before_a_lingering_program_is_reaped() {
    reap_orphans_on_linux();
    let mut host = Host::start();
    host.send(json!({
        "type":"invoke", "id":1, "fn":"", "args":[], "routed":true,
        "contract":{
            "plugin":"fixture", "owner":"fixture", "name":"programs",
            "registration":"programFixture", "method":"linger"
        }
    }))
    .await;
    let auth = host.receive().await;
    assert_eq!(auth["name"], "auth.current");
    host.send(json!({ "type":"opResult", "id":auth["id"], "value":{} }))
        .await;
    let frame = host.receive().await;
    let pid = frame["value"].as_i64().expect("program PID") as i32;
    assert!(pid > 1 && unsafe { libc::kill(pid, 0) } == 0, "{frame}");
    assert_gone(&[pid]).await;
}

#[tokio::test]
async fn native_force_stop_reaps_a_lingering_program_after_the_result() {
    reap_orphans_on_linux();
    let bundle = fixture();
    let (mut host, control) = Process::launch_plugin(
        "fixture",
        &bundle,
        bundle.parent().unwrap(),
        &BTreeMap::new(),
    )
    .unwrap();
    let control = UnixDatagram::from_std(control).unwrap();
    let (mut input, stdout, _stderr) = host.pipes().unwrap();
    let mut output = BufReader::new(stdout).lines();
    support::send(
        &mut input,
        json!({
            "type":"invoke", "id":1, "fn":"", "args":[], "routed":true,
            "contract":{
                "plugin":"fixture", "owner":"fixture", "name":"programs",
                "registration":"programFixture", "method":"linger"
            }
        }),
    )
    .await;
    let auth = support::receive(&mut output).await;
    assert_eq!(auth["name"], "auth.current");
    support::send(
        &mut input,
        json!({ "type":"opResult", "id":auth["id"], "value":{} }),
    )
    .await;
    let frame = support::receive(&mut output).await;
    let pid = frame["value"].as_i64().expect("program PID") as i32;
    assert!(pid > 1 && unsafe { libc::kill(pid, 0) } == 0, "{frame}");
    timeout(Duration::from_millis(750), async {
        let call = 1_u64.to_le_bytes();
        control.send(&call).await.unwrap();
        let mut answer = [0; 8];
        assert_eq!(control.recv(&mut answer).await.unwrap(), answer.len());
        assert_eq!(answer, call);
        assert_gone(&[pid]).await;
    })
    .await
    .expect("Force stop must not wait for the remaining TERM grace");
}

#[tokio::test]
async fn force_stop_kills_the_whole_scope_tree_and_leaves_the_outer_program() {
    reap_orphans_on_linux();
    let mut host = Host::start();
    host.invoke(1, "scopedTree", json!(tree_path())).await;
    let frame = host.receive().await;
    assert_eq!(
        frame["value"]["outer"],
        json!([["outer survived"], 0]),
        "{frame}"
    );
    assert_eq!(frame["value"]["code"], 137);
    assert_eq!(
        frame["value"]["silent"], true,
        "force stop sent TERM before KILL"
    );
    let [_, tree @ ..] = pids(frame["value"]["pids"].clone());
    assert_gone(&tree).await;
}

#[tokio::test]
async fn sigkill_of_the_host_kills_its_program_tree() {
    reap_orphans_on_linux();
    let mut host = Host::start();
    host.invoke(1, "parkTree", json!(tree_path())).await;
    let [host_pid, tree @ ..] = logged_tree(host.receive().await);
    assert_eq!(host_pid as u32, host.child.id().unwrap());
    host.child.kill().await.unwrap();
    assert_gone(&tree).await;
}

#[tokio::test]
async fn sigkill_of_the_launcher_kills_the_host_and_its_program_tree() {
    reap_orphans_on_linux();
    let started = Instant::now();
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "parent_fixture", "--ignored", "--nocapture"])
        .env("TOKAMAK_PROGRAM_PARENT_FIXTURE", "1")
        .env("TOKAMAK_PLUGIN_RUNTIME", "quickjs")
        .env(
            "TOKAMAK_PLUGIN_HOST",
            env!("CARGO_BIN_EXE_tokamak-plugin-host"),
        )
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    eprintln!("Launcher fixture spawned at {:?}", started.elapsed());
    let mut output = BufReader::new(parent.stdout.take().unwrap()).lines();
    let pids = timeout(Duration::from_secs(12), async {
        while let Some(line) = output.next_line().await.unwrap() {
            if let Some(payload) = line.strip_prefix("PROGRAM_TREE ") {
                eprintln!("PROGRAM_TREE received at {:?}", started.elapsed());
                return pids(serde_json::from_str(payload).unwrap());
            }
        }
        panic!("launcher exited before the program tree was ready");
    })
    .await
    .expect("launcher fixture did not report PROGRAM_TREE");

    parent.kill().await.unwrap();
    assert_gone(&pids).await;
    eprintln!("Launcher fixture tree reaped at {:?}", started.elapsed());
}

// Run in a separate process so the test can SIGKILL the real launcher.
#[tokio::test]
#[ignore = "subprocess fixture for the launcher death test"]
async fn parent_fixture() {
    if std::env::var_os("TOKAMAK_PROGRAM_PARENT_FIXTURE").is_none() {
        return;
    }

    let started = Instant::now();
    eprintln!("Launcher child entered");
    let bundle = fixture();
    let (mut worker, runtime) = Process::launch_local(
        &bundle,
        &bundle,
        bundle.parent().unwrap(),
        &BTreeMap::new(),
        &[],
    )
    .unwrap();
    eprintln!(
        "Launcher child spawned plugin host at {:?}",
        started.elapsed()
    );
    assert_eq!(runtime, LocalRuntime::QuickJs);
    let (mut input, stdout, _stderr) = worker.pipes().unwrap();
    let mut output = BufReader::new(stdout).lines();
    support::invoke(&mut input, &mut output, 1, "parkTree", json!(tree_path())).await;
    eprintln!(
        "Launcher child authorized parkTree at {:?}",
        started.elapsed()
    );
    // Serial libtest prints the test name without a trailing newline.
    println!(
        "\nPROGRAM_TREE {}",
        json!(logged_tree(support::receive(&mut output).await))
    );
    pending::<()>().await;
    drop(worker);
}

#[tokio::test]
async fn output_lines_over_one_mib_fail_only_the_stream() {
    let mut host = Host::start();
    host.invoke(1, "longLine", Value::Null).await;
    assert_eq!(
        host.receive().await["value"],
        json!([
            "Program output line exceeds 1 MiB",
            "ready",
            "received probe",
            137
        ])
    );
}

#[tokio::test]
async fn input_queue_overflow_leaves_the_program_running() {
    let mut host = Host::start();
    host.invoke(1, "inputQueue", Value::Null).await;
    assert_eq!(
        host.receive().await["value"],
        json!([64, "Program input queue exceeds 64 MiB", "stopped", 42])
    );
}

#[tokio::test]
async fn immediate_runs_after_jobs_and_arrived_io_and_before_zero_timer() {
    let mut host = Host::start();
    host.invoke(1, "immediate", Value::Null).await;
    let op = host.receive().await;
    assert_eq!(op["name"], "local.runQuery");
    host.send(json!({ "type": "opResult", "id": op["id"], "value": null }))
        .await;
    assert_eq!(
        host.receive().await["value"],
        json!(["promise", "io", "immediate", "timer"])
    );
}

#[tokio::test]
async fn watchdog_reset_stops_programs_even_when_javascript_cannot_clean_up() {
    reap_orphans_on_linux();
    let mut host = Host::start();
    host.invoke(1, "parkTree", json!(tree_path())).await;
    let [_, tree @ ..] = logged_tree(host.receive().await);

    host.invoke(2, "loop", Value::Null).await;
    assert_eq!(host.receive().await["text"], "loop");
    for _ in 0..2 {
        assert_eq!(
            host.receive().await["error"],
            "Plugin local function did not yield for 5 seconds; QuickJS runtime reset",
        );
    }
    assert_gone(&tree).await;
}
