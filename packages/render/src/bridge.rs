//! Dispatch JS events and apply mutation batches to Blitz.
use crate::{Error, Result, input::Composition, js, wire};
use blitz_dom::Document;
use blitz_traits::{NodeId, events::*};
use keyboard_types::Modifiers;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(super) struct Bridge {
    pub(super) js: js::Js,
    pub(super) tree: wire::Tree,
    pub(super) alive: Arc<AtomicBool>,
    pub(super) composition: Composition,
    pub(super) space: Option<NodeId>,
    pub(super) error: Option<Error>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Response {
    pub(super) prevented: bool,
    pub(super) stopped: bool,
    pub(super) error: Option<String>,
}

impl Bridge {
    pub(super) fn flush(&mut self, doc: &mut dyn Document) -> Result<()> {
        let settled = self.js.settle();
        let applied = (|| {
            let mutations = self
                .js
                .call("drain", None)?
                .ok_or_else(|| Error("Missing mutation batch".into()))?;
            #[derive(Deserialize)]
            struct Batch {
                realm: String,
                mutations: Value,
            }
            let batches: Vec<Batch> = serde_json::from_str(&mutations)
                .map_err(|error| Error(format!("Invalid realm batch: {error}")))?;
            for batch in batches {
                if let Err(error) = self.tree.apply(doc, &batch.mutations.to_string()) {
                    if batch.realm.is_empty() {
                        return Err(error);
                    }
                    self.js.disable_realm(&batch.realm, &error);
                }
            }
            Ok(())
        })();
        // drain consumes the JS batch. A rejected batch cannot safely resume:
        // the JS topology is ahead of Blitz. Freeze this generation and reject
        // all future input/senders instead of reporting unrelated updates as OK.
        // Ordinary listener/job exceptions with a valid applied batch stay recoverable.
        if applied.is_err() {
            self.alive.store(false, Ordering::Release);
        }
        applied?;
        settled
    }

    pub(super) fn dispatch(
        &mut self,
        doc: &mut dyn Document,
        chain: &[NodeId],
        event: &DomEvent,
    ) -> Result<Response> {
        let mut data = json!({ "type":event.name(), "bubbles": event.bubbles,
            "cancelable": event.cancelable, "isComposing":self.composition.active() });
        match &event.data {
            DomEventData::Input(input) => data["value"] = json!(input.value),
            DomEventData::AppleStandardKeybinding(command) => {
                data["command"] = json!(command.as_str())
            }
            DomEventData::KeyDown(key) | DomEventData::KeyUp(key) | DomEventData::KeyPress(key) => {
                data["key"] = json!(key.key.to_string());
                data["code"] = json!(key.code.to_string());
                data["repeat"] = json!(key.is_auto_repeating);
                data["isComposing"] = json!(self.composition.active() || key.is_composing);
                for (name, modifier) in [
                    ("altKey", Modifiers::ALT),
                    ("ctrlKey", Modifiers::CONTROL),
                    ("metaKey", Modifiers::META),
                    ("shiftKey", Modifiers::SHIFT),
                ] {
                    data[name] = json!(key.modifiers.contains(modifier));
                }
            }
            _ => {}
        }
        self.send_event(doc, chain, event.target, data, "Invalid event response: ")
    }

    pub(super) fn activate(&mut self, doc: &mut dyn Document, target: NodeId) -> Result<()> {
        let chain = doc.inner().node_chain(target);
        // Keyboard activation is a JS click with the same bubbling and
        // cancellation contract as a native pointer click, not a second input.
        let response = self.send_event(
            doc,
            &chain,
            target,
            json!({"type":"click","bubbles":true,"cancelable":true,"isComposing":false}),
            "",
        )?;
        if let Some(error) = response.error {
            return Err(Error(error));
        }
        Ok(())
    }

    pub(super) fn send_event(
        &mut self,
        doc: &mut dyn Document,
        chain: &[NodeId],
        target: NodeId,
        mut data: Value,
        response_error_prefix: &str,
    ) -> Result<Response> {
        let handles: Vec<_> = chain
            .iter()
            .filter_map(|id| self.tree.handle(*id))
            .collect();
        data["target"] = json!(self.tree.handle(target).unwrap_or(0));
        data["chain"] = json!(handles);
        let result = self.js.call("dispatch", Some(&data.to_string()));
        // Even a throwing listener may have changed Solid signals. Never let
        // those changes wait for another interaction or paint a stale frame.
        self.flush(doc)?;
        serde_json::from_str(&result?.unwrap_or_default())
            .map_err(|e| Error(format!("{response_error_prefix}{e}")))
    }
}
