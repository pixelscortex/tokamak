//! Validated native mutation boundary. Stage the entire topology first: JS
//! mistakes must become errors, not partial writes or Blitz indexing panics.
use crate::{Error, Result};
use blitz_dom::{Document, Namespace, QualName};
use blitz_traits::NodeId;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
enum Mutation {
    #[serde(rename = "element")]
    Element { id: u32, tag: String },
    #[serde(rename = "text")]
    Text { id: u32, value: String },
    #[serde(rename = "textValue")]
    TextValue { id: u32, value: String },
    #[serde(rename = "attribute")]
    Attribute {
        id: u32,
        name: String,
        #[serde(deserialize_with = "Option::deserialize")]
        value: Option<String>,
    },
    #[serde(rename = "insert")]
    Insert {
        id: u32,
        parent: u32,
        #[serde(deserialize_with = "Option::deserialize")]
        before: Option<u32>,
    },
    #[serde(rename = "detach")]
    Detach { id: u32 },
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Root,
    Element,
    Text,
}

#[derive(Clone, Copy)]
struct Entry {
    kind: Kind,
    parent: Option<u32>,
}

pub(crate) struct Tree {
    topology: HashMap<u32, Entry>,
    native: HashMap<u32, NodeId>,
    handles: HashMap<NodeId, u32>,
    /// `<tk-surface>` widgets and the elements bound to them (surface/bind.rs).
    pub surfaces: crate::surface::Registry,
}

impl Tree {
    pub fn new(root: NodeId) -> Self {
        Self {
            topology: HashMap::from([(
                0,
                Entry {
                    kind: Kind::Root,
                    parent: None,
                },
            )]),
            native: HashMap::from([(0, root)]),
            handles: HashMap::from([(root, 0)]),
            surfaces: Default::default(),
        }
    }

    pub fn handle(&self, native: NodeId) -> Option<u32> {
        self.handles.get(&native).copied()
    }

    pub fn apply(&mut self, document: &mut dyn Document, json: &str) -> Result<()> {
        if json.len() > 4 * 1024 * 1024 {
            return Err(Error("UI mutation batch exceeds 4 MiB".into()));
        }
        let mutations: Vec<Mutation> =
            serde_json::from_str(json).map_err(|e| Error(format!("UI wire: {e}")))?;
        let mut staged = self.topology.clone();
        let invalid = || Error("Invalid UI topology or attribute".into());
        for mutation in &mutations {
            let entry = |id: &u32| staged.get(id).copied().ok_or_else(invalid);
            match mutation {
                Mutation::Element { id, tag } | Mutation::Text { id, value: tag } => {
                    if staged.contains_key(id) {
                        return Err(invalid());
                    }
                    let kind = if matches!(mutation, Mutation::Element { .. }) {
                        if !name_valid(tag) {
                            return Err(invalid());
                        }
                        Kind::Element
                    } else {
                        Kind::Text
                    };
                    staged.insert(*id, Entry { kind, parent: None });
                }
                Mutation::TextValue { id, .. } => {
                    if entry(id)?.kind != Kind::Text {
                        return Err(invalid());
                    }
                }
                Mutation::Attribute { id, name, .. } => {
                    if entry(id)?.kind != Kind::Element
                        || !name_valid(name)
                        || name.starts_with("on")
                    {
                        return Err(invalid());
                    }
                }
                Mutation::Detach { id } => {
                    if entry(id)?.kind == Kind::Root || entry(id)?.parent.is_none() {
                        return Err(invalid());
                    }
                    staged.get_mut(id).unwrap().parent = None;
                }
                Mutation::Insert { id, parent, before } => {
                    if entry(id)?.kind == Kind::Root || entry(parent)?.kind == Kind::Text {
                        return Err(invalid());
                    }
                    if let Some(before) = before {
                        if entry(before)?.parent != Some(*parent) {
                            return Err(invalid());
                        }
                    }
                    let mut ancestor = Some(*parent);
                    while let Some(current) = ancestor {
                        if current == *id {
                            return Err(invalid());
                        }
                        ancestor = entry(&current)?.parent;
                    }
                    staged.get_mut(id).unwrap().parent = Some(*parent);
                }
            }
        }
        let mut inner = document.inner_mut();
        let mut dom = inner.mutate();
        for mutation in mutations {
            match mutation {
                Mutation::Element { id, tag } => {
                    let native = dom.create_element(
                        QualName::new(
                            None,
                            Namespace::from("http://www.w3.org/1999/xhtml"),
                            tag.as_str().into(),
                        ),
                        vec![],
                    );
                    // Native widgets (`<tk-surface>`, `<tk-icon>`) attach before
                    // attributes arrive, so each one reaches attribute_changed.
                    if let Some(widget) =
                        crate::surface::widget_for(&tag, native, &mut self.surfaces)
                    {
                        dom.set_custom_widget(native, widget);
                    }
                    self.native.insert(id, native);
                    self.handles.insert(native, id);
                }
                Mutation::Text { id, value } => {
                    let native = dom.create_text_node(&value);
                    self.native.insert(id, native);
                    self.handles.insert(native, id);
                }
                Mutation::TextValue { id, value } => dom.set_node_text(self.native[&id], &value),
                Mutation::Attribute { id, name, value } => {
                    if name == "surface-groups" {
                        self.surfaces.member(self.native[&id], value.is_some());
                    }
                    // Plates (surface/bind.rs, "Plates"): the build's marker,
                    // and the `class` scan for classes built at run time. A
                    // plate found by the scan gets the marker here, natively
                    // (JS never sees it), so the stylesheet treats it like a
                    // marked one.
                    match name.as_str() {
                        "tk-plate" => self
                            .surfaces
                            .plate_marker(self.native[&id], value.is_some()),
                        "class" => {
                            let native = self.native[&id];
                            if let Some(plate) = self.surfaces.plate_class(native, value.as_deref())
                            {
                                let marker =
                                    QualName::new(None, Namespace::from(""), "tk-plate".into());
                                if plate {
                                    dom.set_attribute(native, marker, "");
                                } else {
                                    dom.clear_attribute(native, marker);
                                }
                            }
                        }
                        _ => {}
                    }
                    let attribute = QualName::new(None, Namespace::from(""), name.into());
                    if let Some(value) = value {
                        dom.set_attribute(self.native[&id], attribute, &value);
                    } else {
                        dom.clear_attribute(self.native[&id], attribute);
                    }
                }
                Mutation::Insert { id, parent, before } => {
                    if before == Some(id) {
                        continue;
                    }
                    if let Some(before) = before {
                        dom.insert_nodes_before(self.native[&before], &[self.native[&id]]);
                    } else {
                        dom.append_children(self.native[&parent], &[self.native[&id]]);
                    }
                }
                Mutation::Detach { id } => dom.remove_node(self.native[&id]),
            }
        }
        self.topology = staged;
        Ok(())
    }
}

fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || (i > 0 && (b.is_ascii_digit() || b == b'-' || b == b':'))
        })
}
