//! Experimental client-realm vertical slice. Only JSON strings cross contexts.
//! All entries run under the enclosing window runtime lock on its owner thread.
use crate::{Error, Result};
use engine::rquickjs::{CaughtError, Ctx, Exception, Function, Object, qjs};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ptr::NonNull,
    rc::Rc,
    time::Instant,
};

type ContextPointer = NonNull<qjs::JSContext>;
type Grant = (String, u64, bool);

pub(crate) struct Realms {
    bundle: String,
    disabled: RefCell<HashSet<String>>,
    contexts: RefCell<HashMap<String, ContextPointer>>,
    grants: RefCell<HashMap<(String, u64), Grant>>,
    next_grant: RefCell<u64>,
    nodes: RefCell<HashMap<(String, u32), u32>>,
    roots: RefCell<HashMap<(String, u32), u32>>,
    next_node: RefCell<u32>,
    mounts: RefCell<Vec<(String, String, u32, Value)>>,
    next_mount: RefCell<u32>,
    mount_owners: RefCell<HashMap<(String, u32), String>>,
    updates: RefCell<Vec<(String, String, Value)>>,
}

impl Realms {
    pub(crate) fn new(bundle: &str) -> Rc<Self> {
        Rc::new(Self {
            bundle: bundle.into(),
            disabled: Default::default(),
            contexts: Default::default(),
            grants: Default::default(),
            next_grant: RefCell::new(1),
            nodes: Default::default(),
            roots: Default::default(),
            next_node: RefCell::new(1),
            mounts: Default::default(),
            next_mount: RefCell::new(0x8000_0000),
            mount_owners: Default::default(),
            updates: Default::default(),
        })
    }

    pub(crate) fn install(self: &Rc<Self>, ctx: &Ctx<'_>, name: &str) -> Result<()> {
        let broker = self.clone();
        let caller = name.to_string();
        ctx.globals().set("__tokamakRealmName", name).map_err(err)?;
        ctx.globals()
            .set(
                "__tokamakRealm",
                Function::new(
                    ctx.clone(),
                    move |ctx: Ctx<'_>, op: String, input: String| {
                        broker
                            .operation(&ctx, &caller, &op, &input)
                            .map_err(|e| Exception::throw_message(&ctx, &e.0))
                    },
                )
                .map_err(err)?,
            )
            .map_err(err)?;
        self.contexts.borrow_mut().insert(name.into(), ctx.as_raw());
        if name.is_empty() {
            self.roots.borrow_mut().insert((name.into(), 0), 0);
        }
        Ok(())
    }

    fn operation(
        self: &Rc<Self>,
        ctx: &Ctx<'_>,
        caller: &str,
        op: &str,
        input: &str,
    ) -> Result<String> {
        let data: Value = serde_json::from_str(input).map_err(err)?;
        match op {
            "create" if caller.is_empty() => {
                let name = string(&data, "name")?;
                if name.is_empty() || self.contexts.borrow().contains_key(name) {
                    return Err(Error("Duplicate client realm".into()));
                }
                let started = Instant::now();
                let before = memory(ctx);
                // SAFETY: callback holds this runtime's lock. The broker owns the
                // new reference until release(); no JS value leaves this scope.
                let ptr = NonNull::new(unsafe {
                    qjs::JS_NewContext(qjs::JS_GetRuntime(ctx.as_raw().as_ptr()))
                })
                .ok_or_else(|| Error("Cannot allocate client context".into()))?;
                let child = unsafe { Ctx::from_raw(ptr) };
                self.install(&child, name)?;
                // Slice intentionally exposes no native clipboard/timer or socket
                // capabilities to plugin contexts. Services arrive as grants.
                for global in ["__tokamakClipboard", "__tokamakAfter"] {
                    child
                        .globals()
                        .set(
                            global,
                            Function::new(
                                child.clone(),
                                |ctx: Ctx<'_>| -> engine::rquickjs::Result<()> {
                                    Err(Exception::throw_message(
                                        &ctx,
                                        "Capability not implemented in realm slice",
                                    ))
                                },
                            )
                            .map_err(err)?,
                        )
                        .map_err(err)?;
                }
                child
                    .globals()
                    .set(
                        "__tokamakWarn",
                        Function::new(child.clone(), |message: String| {
                            eprintln!("Client realm: {message}")
                        })
                        .map_err(err)?,
                    )
                    .map_err(err)?;
                child
                    .eval::<(), _>(self.bundle.as_str())
                    .map_err(|e| caught(&child, e))?;
                eprintln!(
                    "Client realm {name}: bootstrap {} bytes, {:?}",
                    memory(ctx) - before,
                    started.elapsed()
                );
                Ok("null".into())
            }
            "enter" if caller.is_empty() => {
                let target = string(&data, "target")?;
                let method = string(&data, "method")?;
                let payload = self.transfer(caller, target, data["payload"].clone())?;
                let result = self.enter(target, method, payload)?;
                Ok(self.transfer(target, caller, result)?.to_string())
            }
            "call" => {
                let token = data["token"]
                    .as_u64()
                    .ok_or_else(|| Error("Invalid call token".into()))?;
                let (target, id, _) = self
                    .grants
                    .borrow()
                    .get(&(caller.into(), token))
                    .cloned()
                    .ok_or_else(|| Error("Foreign client capability".into()))?;
                let args = self.transfer(caller, &target, data["args"].clone())?;
                let result = self.enter(&target, "invoke", json!({"id": id, "args": args}))?;
                Ok(self.transfer(&target, caller, result)?.to_string())
            }
            "portal" => {
                let token = data["token"]
                    .as_u64()
                    .ok_or_else(|| Error("Invalid render token".into()))?;
                let (target, id, component) = self
                    .grants
                    .borrow()
                    .get(&(caller.into(), token))
                    .cloned()
                    .ok_or_else(|| Error("Foreign render capability".into()))?;
                if !component {
                    return Err(Error("Capability is not a component".into()));
                }
                let parent = data["parent"]
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or_else(|| Error("Invalid portal parent".into()))?;
                let props = self.transfer(caller, &target, data["props"].clone())?;
                let mut next = self.next_mount.borrow_mut();
                let mount = *next;
                *next = next
                    .checked_add(1)
                    .ok_or_else(|| Error("Too many mounts".into()))?;
                self.mount_owners
                    .borrow_mut()
                    .insert((caller.into(), mount), target.clone());
                self.mounts.borrow_mut().push((
                    caller.into(),
                    target,
                    parent,
                    json!({"id":id,"mount":mount,"props":props}),
                ));
                Ok(mount.to_string())
            }
            "update" | "unmount" => {
                let mount = data["mount"]
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or_else(|| Error("Invalid mount".into()))?;
                let target = self
                    .mount_owners
                    .borrow()
                    .get(&(caller.into(), mount))
                    .cloned()
                    .ok_or_else(|| Error("Foreign mount".into()))?;
                let payload = if op == "update" {
                    json!({"mount":mount,"props":self.transfer(caller,&target,data["props"].clone())?})
                } else {
                    json!({"mount":mount})
                };
                self.updates.borrow_mut().push((target, op.into(), payload));
                if op == "unmount" {
                    self.mount_owners
                        .borrow_mut()
                        .remove(&(caller.into(), mount));
                }
                Ok("null".into())
            }
            _ => Err(Error(format!("Client realm operation denied: {op}"))),
        }
    }

    // A tagged value tree distinguishes user JSON from capabilities. A caller
    // can mint its own functions, or forward grants it already holds. It cannot
    // name another realm's private functions, globals, or registry operations.
    fn transfer(&self, source: &str, target: &str, value: Value) -> Result<Value> {
        let items = value
            .as_array()
            .ok_or_else(|| Error("Invalid realm value".into()))?;
        let payload = items.get(1).unwrap_or(&Value::Null);
        match items.first().and_then(Value::as_str) {
            Some("fn" | "ref") => {
                let id = items
                    .get(1)
                    .and_then(Value::as_u64)
                    .ok_or_else(|| Error("Invalid function reference".into()))?;
                let grant = if items[0] == "fn" {
                    (source.into(), id, items.get(2) == Some(&Value::Bool(true)))
                } else {
                    self.grants
                        .borrow()
                        .get(&(source.into(), id))
                        .cloned()
                        .ok_or_else(|| Error("Foreign forwarded capability".into()))?
                };
                if grant.0 == target {
                    return Ok(json!(["fn", grant.1, grant.2]));
                }
                let mut next = self.next_grant.borrow_mut();
                let token = *next;
                *next += 1;
                self.grants
                    .borrow_mut()
                    .insert((target.into(), token), grant.clone());
                Ok(json!(["ref", token, grant.2]))
            }
            Some("array") => Ok(json!([
                "array",
                payload
                    .as_array()
                    .ok_or_else(|| Error("Invalid array".into()))?
                    .iter()
                    .map(|v| self.transfer(source, target, v.clone()))
                    .collect::<Result<Vec<_>>>()?
            ])),
            Some("object") => {
                let mut result = serde_json::Map::new();
                for (key, value) in payload
                    .as_object()
                    .ok_or_else(|| Error("Invalid object".into()))?
                {
                    result.insert(key.clone(), self.transfer(source, target, value.clone())?);
                }
                Ok(json!(["object", result]))
            }
            Some("promise") => Ok(json!([
                "promise",
                self.transfer(source, target, payload.clone())?
            ])),
            Some("value" | "undefined" | "error" | "reference") => Ok(value),
            _ => Err(Error("Invalid realm value tag".into())),
        }
    }

    fn enter(&self, name: &str, method: &str, payload: Value) -> Result<Value> {
        if self.disabled.borrow().contains(name) && !matches!(method, "dispose" | "unmount") {
            return Err(Error("Client realm is retired".into()));
        }
        let pointer = *self
            .contexts
            .borrow()
            .get(name)
            .ok_or_else(|| Error("Unknown client realm".into()))?;
        // SAFETY: only called while the window runtime lock is held. Contexts
        // stay alive until release(), and only an owned string is returned.
        let ctx = unsafe { Ctx::from_raw(pointer) };
        let result = (|| -> engine::rquickjs::Result<String> {
            let entry: Function = ctx.globals().get("__tokamakRealmEntry")?;
            entry.call((method, payload.to_string()))
        })()
        .map_err(|e| caught(&ctx, e))?;
        serde_json::from_str(&result).map_err(err)
    }

    fn node(&self, realm: &str, local: u32) -> Result<u32> {
        self.nodes
            .borrow()
            .get(&(realm.into(), local))
            .copied()
            .or_else(|| self.roots.borrow().get(&(realm.into(), local)).copied())
            .ok_or_else(|| Error(format!("Foreign or unknown node {realm}:{local}")))
    }

    pub(crate) fn drain(&self, shell: String) -> Result<String> {
        let mut batches = vec![(String::new(), shell)];
        let mut result = Vec::new();
        // A mounted component may create another portal. Bound work per turn.
        for _ in 0..32 {
            for (realm, batch) in batches.drain(..) {
                if self.disabled.borrow().contains(&realm) {
                    continue;
                }
                match self.remap(&realm, &batch) {
                    Ok(mutations) => result.push(json!({"realm":realm,"mutations":mutations})),
                    Err(error) if !realm.is_empty() => self.disable(&realm, &error),
                    Err(error) => return Err(error),
                }
            }
            let mounts = self.mounts.take();
            for (caller, target, parent, payload) in mounts {
                if self.disabled.borrow().contains(&caller)
                    || self.disabled.borrow().contains(&target)
                {
                    continue;
                }
                let Some(native) = self.nodes.borrow().get(&(caller.clone(), parent)).copied()
                else {
                    // The point may have been created by another context during
                    // this drain. Apply its queued element before connecting it.
                    self.mounts
                        .borrow_mut()
                        .push((caller, target, parent, payload));
                    continue;
                };
                let mount = payload["mount"].as_u64().unwrap() as u32;
                self.roots
                    .borrow_mut()
                    .insert((target.clone(), mount), native);
                self.enter(&target, "mount", payload)?;
            }
            for (target, method, payload) in self.updates.take() {
                if self.disabled.borrow().contains(&target) {
                    continue;
                }
                self.enter(&target, &method, payload)?;
            }
            let names: Vec<_> = self.contexts.borrow().keys().cloned().collect();
            for name in names {
                if self.disabled.borrow().contains(&name) {
                    continue;
                }
                match self.api(&name, "drain", None) {
                    Ok(batch) if batch != "[]" => batches.push((name, batch)),
                    Ok(_) => {}
                    Err(error) if !name.is_empty() => self.disable(&name, &error),
                    Err(error) => return Err(error),
                }
            }
            if batches.is_empty()
                && self.mounts.borrow().is_empty()
                && self.updates.borrow().is_empty()
            {
                return Ok(Value::Array(result).to_string());
            }
        }
        Err(Error("Client portal work budget exceeded".into()))
    }

    fn remap(&self, realm: &str, batch: &str) -> Result<Vec<Value>> {
        let previous = self.nodes.borrow().clone();
        let result = (|| {
            let mutations: Vec<Value> = serde_json::from_str(batch).map_err(err)?;
            let mut mapped = Vec::new();
            for mut mutation in mutations {
                let local = mutation["id"]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| Error("Invalid local node".into()))?;
                let op = mutation["op"].as_str().unwrap_or_default();
                if op == "element" || op == "text" {
                    let key = (realm.to_string(), local);
                    if self.nodes.borrow().contains_key(&key)
                        || self.roots.borrow().contains_key(&key)
                        || local >= 0x8000_0000
                    {
                        return Err(Error("Duplicate or reserved local node".into()));
                    }
                    let mut next = self.next_node.borrow_mut();
                    let global = if realm.is_empty() && self.contexts.borrow().len() == 1 {
                        local
                    } else {
                        *next
                    };
                    self.nodes.borrow_mut().insert(key, global);
                    *next = (*next).max(
                        global
                            .checked_add(1)
                            .ok_or_else(|| Error("Too many client nodes".into()))?,
                    );
                } else if self
                    .roots
                    .borrow()
                    .contains_key(&(realm.to_string(), local))
                {
                    return Err(Error("Cannot mutate a foreign mount point".into()));
                }
                let insert = op == "insert";
                mutation["id"] = json!(self.node(realm, local)?);
                if insert {
                    for field in ["parent", "before"] {
                        if !mutation[field].is_null() {
                            let id = mutation[field]
                                .as_u64()
                                .and_then(|n| u32::try_from(n).ok())
                                .ok_or_else(|| Error("Invalid local node reference".into()))?;
                            mutation[field] = json!(self.node(realm, id)?);
                        }
                    }
                }
                mapped.push(mutation);
            }
            Ok(mapped)
        })();
        if result.is_err() {
            *self.nodes.borrow_mut() = previous;
        }
        result
    }

    pub(crate) fn disable(&self, realm: &str, error: &Error) {
        self.disabled.borrow_mut().insert(realm.into());
        eprintln!("Client realm {realm} retired after invalid render data: {error}");
    }

    fn api(&self, name: &str, method: &str, input: Option<&str>) -> Result<String> {
        if self.disabled.borrow().contains(name) {
            return Err(Error("Client realm is retired".into()));
        }
        let pointer = *self
            .contexts
            .borrow()
            .get(name)
            .ok_or_else(|| Error("Unknown client realm".into()))?;
        // SAFETY: same locked-runtime and owned-string boundary as enter().
        let ctx = unsafe { Ctx::from_raw(pointer) };
        (|| -> engine::rquickjs::Result<String> {
            let api: Object = ctx.globals().get("__tokamak")?;
            let function: Function = api.get(method)?;
            if method == "drain" {
                function.call(())
            } else if method == "dispatch" {
                function.call((input.unwrap_or("null"),))
            } else {
                function.call::<_, ()>((input.unwrap_or("null"),))?;
                Ok("null".into())
            }
        })()
        .map_err(|e| caught(&ctx, e))
    }

    pub(crate) fn dispatch(&self, input: &str) -> Result<String> {
        if self.contexts.borrow().len() == 1 {
            return self.api("", "dispatch", Some(input));
        }
        let event: Value = serde_json::from_str(input).map_err(err)?;
        let nodes = self.nodes.borrow().clone();
        let chain = event["chain"]
            .as_array()
            .ok_or_else(|| Error("Invalid event chain".into()))?;
        let mut groups: Vec<(String, Vec<u32>)> = Vec::new();
        for id in chain {
            let Some(((realm, local), _)) = nodes
                .iter()
                .find(|(_, global)| Some(u64::from(**global)) == id.as_u64())
            else {
                continue;
            };
            if groups.last().is_none_or(|g| &g.0 != realm) {
                groups.push((realm.clone(), Vec::new()));
            }
            groups.last_mut().unwrap().1.push(*local);
        }
        let mut response = json!({"prevented":false,"stopped":false,"error":null});
        for (name, chain) in groups {
            if self.disabled.borrow().contains(&name) {
                continue;
            }
            let mut local = event.clone();
            local["target"] = json!(
                nodes
                    .iter()
                    .find(|((realm, _), global)| realm == &name
                        && Some(u64::from(**global)) == event["target"].as_u64())
                    .map_or(0, |((_, id), _)| *id)
            );
            local["chain"] = json!(chain);
            local["prevented"] = response["prevented"].clone();
            let next: Value =
                serde_json::from_str(&self.api(&name, "dispatch", Some(&local.to_string()))?)
                    .map_err(err)?;
            if next["prevented"] == true {
                response["prevented"] = json!(true);
            }
            response["error"] = next["error"].clone();
            if next["stopped"] == true {
                response["stopped"] = json!(true);
                break;
            }
        }
        Ok(response.to_string())
    }

    pub(crate) fn host_event(&self, input: &str) -> Result<()> {
        if self.contexts.borrow().len() == 1 {
            self.api("", "host", Some(input))?;
            return Ok(());
        }
        let event: Value = serde_json::from_str(input).map_err(err)?;
        let names: Vec<_> = self.contexts.borrow().keys().cloned().collect();
        for name in names {
            if self.disabled.borrow().contains(&name) {
                continue;
            }
            let mut local = event.clone();
            match event["topic"].as_str() {
                Some("tk:layout") => {
                    let mut changes = Vec::new();
                    for change in event["payload"]
                        .as_array()
                        .ok_or_else(|| Error("Invalid layouts".into()))?
                    {
                        if let Some(((.., id), _)) =
                            self.nodes.borrow().iter().find(|((realm, _), global)| {
                                realm == &name && Some(u64::from(**global)) == change["id"].as_u64()
                            })
                        {
                            let mut change = change.clone();
                            change["id"] = json!(id);
                            changes.push(change);
                        }
                    }
                    local["payload"] = json!(changes);
                }
                Some("tk:caret") => {
                    let Some(id) = self
                        .nodes
                        .borrow()
                        .iter()
                        .find(|((realm, _), global)| {
                            realm == &name
                                && Some(u64::from(**global)) == event["payload"]["id"].as_u64()
                        })
                        .map(|((_, id), _)| *id)
                    else {
                        continue;
                    };
                    local["payload"]["id"] = json!(id);
                }
                _ if !name.is_empty() => continue,
                _ => {}
            }
            self.api(&name, "host", Some(&local.to_string()))?;
        }
        Ok(())
    }

    // Called under the runtime lock before the window context/runtime drops.
    pub(crate) fn release(&self) {
        let contexts = self.contexts.take();
        for (name, pointer) in contexts {
            if name.is_empty() {
                continue;
            }
            // SAFETY: balances the owned JS_NewContext reference above. All
            // transient Ctx handles and calls have finished on this thread.
            unsafe {
                qjs::JS_FreeContext(pointer.as_ptr());
            }
        }
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| Error(format!("Missing realm field {key}")))
}
fn err(error: impl std::fmt::Display) -> Error {
    Error(error.to_string())
}
fn caught(ctx: &Ctx<'_>, error: engine::rquickjs::Error) -> Error {
    Error(CaughtError::from_error(ctx, error).to_string())
}

fn memory(ctx: &Ctx<'_>) -> i64 {
    // SAFETY: the runtime lock is held; this reads counters into a POD struct.
    unsafe {
        let mut usage: qjs::JSMemoryUsage = std::mem::zeroed();
        qjs::JS_ComputeMemoryUsage(qjs::JS_GetRuntime(ctx.as_raw().as_ptr()), &mut usage);
        usage.memory_used_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn function_grants_are_scoped_to_recipients_and_forward_only_existing_authority() {
        let broker = Realms::new("");
        let granted = broker
            .transfer("chat", "filler", json!(["fn", 7, true]))
            .unwrap();
        assert_eq!(granted[0], "ref");
        assert!(broker.transfer("other", "shell", granted.clone()).is_err());
        let forwarded = broker.transfer("filler", "shell", granted.clone()).unwrap();
        assert_eq!(
            broker.transfer("shell", "chat", forwarded).unwrap(),
            json!(["fn", 7, true])
        );
        assert!(
            broker
                .transfer("filler", "chat", json!(["ref", 999]))
                .is_err()
        );
    }

    #[test]
    fn malformed_tagged_payloads_return_errors_without_panicking() {
        let broker = Realms::new("");
        for value in [
            json!([]),
            json!(["array"]),
            json!(["object"]),
            json!(["promise"]),
            json!(["ref"]),
            json!(["array", [null]]),
        ] {
            assert!(
                broker.transfer("filler", "chat", value.clone()).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn node_namespaces_and_mount_points_do_not_confer_foreign_mutation_rights() {
        let broker = Realms::new("");
        broker
            .remap("chat", r#"[{"op":"element","id":1,"tag":"textarea"}]"#)
            .unwrap();
        assert!(broker.node("filler", 1).is_err());
        broker
            .remap("filler", r#"[{"op":"element","id":1,"tag":"button"}]"#)
            .unwrap();
        assert_ne!(
            broker.node("filler", 1).unwrap(),
            broker.node("chat", 1).unwrap()
        );
        broker.roots.borrow_mut().insert(
            ("filler".into(), 0x8000_0000),
            broker.node("chat", 1).unwrap(),
        );
        assert!(
            broker
                .remap(
                    "filler",
                    r#"[{"op":"attribute","id":2147483648,"name":"value","value":"stolen"}]"#
                )
                .is_err()
        );
        assert!(
            broker
                .remap(
                    "filler",
                    r#"[{"op":"attribute","id":0,"name":"value","value":"stolen"}]"#
                )
                .is_err()
        );
    }
}
