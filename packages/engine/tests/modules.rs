//! Delegation uses the real engine/world without recursively occupying its pool.
use engine::{Bundle, ModuleCall, OpRegistry, Pool, PoolConfig};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[test]
fn nested_calls_complete_with_one_worker_and_keep_native_authority_explicit() {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
        let pool = Pool::new(PoolConfig { workers: 1, ..PoolConfig::default() }).unwrap();
        let child = Arc::new(Bundle::new(
            "export async function invoke(args, host) { return await host.op('read',args); }", None).unwrap());
        let root = Arc::new(Bundle::new(
            "export async function invoke(args, host) { return [await host.op('delegate',{n:1}), await host.op('delegate',{n:2})]; }", None).unwrap());
        let failures = Arc::new(Mutex::new(Vec::new()));
        let mut ops = OpRegistry::new();
        let observed = failures.clone();
        ops.register_module("delegate", move |args| {
            let mut ops = OpRegistry::new();
            ops.register_sync("read", |args| Ok(json!(args["n"].as_i64().unwrap() + 1))).unwrap();
            let observed = observed.clone();
            Ok(ModuleCall::new(child.clone(), "invoke", args, Arc::new(ops),
                move |error| observed.lock().unwrap().push(error)))
        }).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5),
            pool.submit(root, "invoke", json!({}), Arc::new(ops)).unwrap()).await.unwrap().unwrap();
        assert_eq!(result, json!([2,3]));
        assert!(failures.lock().unwrap().is_empty());
    });
}

#[test]
fn caught_errors_and_abandoned_delegations_notify_the_native_owner() {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
        let pool = Pool::new(PoolConfig { workers: 1, ..PoolConfig::default() }).unwrap();
        for (source, child, expected) in [
            ("export async function invoke(args,host){try{await host.op('delegate',{});}catch{}return 'caught';}",
             "export function invoke(){throw new Error('child failure');}", "child failure"),
            ("export function invoke(args,host){host.op('delegate',{}).catch(()=>{});return 'done';}",
             "export async function invoke(){await new Promise(()=>{});}", "abandoned"),
        ] {
            let failures = Arc::new(Mutex::new(Vec::new()));
            let observed = failures.clone();
            let child = Arc::new(Bundle::new(child, None).unwrap());
            let mut ops = OpRegistry::new();
            ops.register_module("delegate", move |args| {
                let observed = observed.clone();
                Ok(ModuleCall::new(child.clone(), "invoke", args, Arc::new(OpRegistry::new()),
                    move |error| observed.lock().unwrap().push(error)))
            }).unwrap();
            let root = Arc::new(Bundle::new(source, None).unwrap());
            let result = pool.submit(root, "invoke", json!({}), Arc::new(ops)).unwrap().await;
            assert!(result.is_ok());
            assert!(failures.lock().unwrap().iter().any(|error| error.contains(expected)),
                "{:?}", failures.lock().unwrap());
        }
    });
}
