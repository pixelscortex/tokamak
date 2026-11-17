//! TKM-8 acceptance through real QuickJS, Solid universal JSX and Blitz defaults.
//! Pointer/keyboard/IME here are injected document events, NOT physical macOS
//! input or window-presentation proof. Foreground/manual gates live in README.md.
use blitz_dom::{Document, Namespace, QualName};
use blitz_traits::{
    NodeId,
    events::*,
    shell::{ClipboardError, ShellProvider, Viewport},
};
use keyboard_types::{Code, Key, Location, Modifiers, NamedKey};
use render::NativeDocument;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

const SHELL: &str = r#"<!doctype html><html><head><style>
body { margin: 0; font: 16px system-ui; }
main { display: flex; flex-direction: column; gap: 4px; padding: 12px; }
button, input { display: block; width: 240px; height: 36px; }
p { margin: 0; } section { display: flex; }
</style></head><body><div id="app"></div></body></html>"#;

fn document() -> NativeDocument {
    let bundle = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/dist/tests/component.js"
    ))
    .expect("Run moon run render:test to build the universal fixture first");
    let mut doc = NativeDocument::new(SHELL, &bundle).unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: (800, 1200),
        ..Default::default()
    });
    doc.inner_mut().resolve(0.0);
    doc
}

fn id(doc: &NativeDocument, name: &str) -> NodeId {
    doc.inner().get_element_by_id(name).unwrap()
}

fn text(doc: &NativeDocument, name: &str) -> String {
    doc.inner().get_node(id(doc, name)).unwrap().text_content()
}

fn attr(doc: &NativeDocument, name: &str, attribute: &str) -> Option<String> {
    doc.inner()
        .get_node(id(doc, name))
        .unwrap()
        .element_data()
        .unwrap()
        .attr(QualName::new(None, Namespace::from(""), attribute.into()).local)
        .map(str::to_owned)
}

fn host(doc: &mut NativeDocument, topic: &str, payload: Value) {
    assert!(doc.host_event(doc.generation(), topic, payload).unwrap());
}

fn policy(doc: &mut NativeDocument, disabled: bool, readonly: bool, cancel: bool, stop: bool) {
    host(
        doc,
        "policy",
        json!({"disabled":disabled,"readonly":readonly,"cancel":cancel,"stop":stop}),
    );
}

fn key(doc: &mut NativeDocument, key: Key, up: bool, repeat: bool) {
    modified_key(doc, key, up, repeat, Modifiers::empty());
}

fn modified_key(doc: &mut NativeDocument, key: Key, up: bool, repeat: bool, modifiers: Modifiers) {
    let code = match &key {
        Key::Named(NamedKey::Tab) => Code::Tab,
        Key::Named(NamedKey::Enter) => Code::Enter,
        Key::Named(NamedKey::Escape) => Code::Escape,
        Key::Named(NamedKey::ArrowRight) => Code::ArrowRight,
        Key::Character(s) if s == " " => Code::Space,
        _ => Code::KeyA,
    };
    let text = match &key {
        Key::Character(s) => Some(s.as_str().into()),
        _ => None,
    };
    let event = BlitzKeyEvent {
        key,
        code,
        text,
        modifiers,
        location: Location::Standard,
        is_auto_repeating: repeat,
        is_composing: false,
        state: if up {
            KeyState::Released
        } else {
            KeyState::Pressed
        },
    };
    doc.handle_ui_event(if up {
        UiEvent::KeyUp(event)
    } else {
        UiEvent::KeyDown(event)
    });
}

fn tab(doc: &mut NativeDocument) {
    key(doc, Key::Named(NamedKey::Tab), false, false);
}

fn pointer(doc: &mut NativeDocument, name: &str) {
    doc.inner_mut().resolve(0.0);
    let rect = doc.inner().get_client_bounding_rect(id(doc, name)).unwrap();
    assert!(rect.width > 0.0 && rect.height > 0.0);
    let (x, y) = (
        (rect.x + rect.width / 2.0) as f32,
        (rect.y + rect.height / 2.0) as f32,
    );
    let mut event = BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons: MouseEventButtons::Primary,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    };
    doc.handle_ui_event(UiEvent::PointerDown(event.clone()));
    event.buttons = MouseEventButtons::None;
    doc.handle_ui_event(UiEvent::PointerUp(event));
}

fn editor(doc: &NativeDocument) -> String {
    doc.inner()
        .get_node(id(doc, "editor"))
        .unwrap()
        .element_data()
        .unwrap()
        .text_input_data()
        .unwrap()
        .editor
        .raw_text()
        .to_owned()
}

#[test]
fn shipped_demo_bundle_reacts_to_typed_host_ticks() {
    // Done-when: validate the actual production task output too, not only the
    // test bundler. A syntactically valid bundle can silently miscompile TSX.
    let bundle =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/demo.js")).unwrap();
    let mut doc = NativeDocument::new(include_str!("../demo/shell.html"), &bundle).unwrap();
    assert_eq!(text(&doc, "host"), "Host ticks (no interaction needed): 0");
    host(&mut doc, "tick", json!({"count":3}));
    assert_eq!(text(&doc, "host"), "Host ticks (no interaction needed): 3");
}

#[test]
fn owned_thread_payload_updates_idle_tree_and_closed_generation_is_rejected() {
    // Done-when: typed host payloads update an idle Solid tree, without a key or
    // pointer event. This bounded embedder mailbox tests public host_event, not
    // HostSender's private Winit wake path; no JS/native handles cross threads.
    #[derive(Serialize)]
    struct Update {
        label: String,
        count: u32,
    }

    let mut doc = document();
    assert_eq!(text(&doc, "host"), "idle");
    let old_generation = doc.generation();
    let (send, receive) = mpsc::sync_channel(1);
    let producer = thread::spawn(move || {
        send.send((
            old_generation,
            serde_json::to_value(Update {
                label: "host 'quoted' 日本語\nline".into(),
                count: 7,
            })
            .unwrap(),
        ))
        .unwrap();
    });
    let (generation, payload) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    producer.join().unwrap();
    assert!(
        doc.host_event(generation, "update", payload.clone())
            .unwrap()
    );
    assert_eq!(text(&doc, "host"), "host 'quoted' 日本語\nline");
    assert_eq!(text(&doc, "count"), "7");
    assert_eq!(
        attr(&doc, "panel", "class").as_deref(),
        Some("active panel")
    );
    assert_eq!(attr(&doc, "panel", "data-count").as_deref(), Some("7"));
    assert_eq!(
        attr(&doc, "activate", "aria-pressed").as_deref(),
        Some("true")
    );
    drop(doc);
    let mut replacement = document();
    assert_ne!(replacement.generation(), generation);
    assert!(
        !replacement
            .host_event(generation, "update", payload)
            .unwrap()
    );
    assert_eq!(text(&replacement, "host"), "idle");
    host(
        &mut replacement,
        "update",
        json!({"label":"new generation","count":2}),
    );
    assert_eq!(text(&replacement, "host"), "new generation");
}

#[test]
fn pointer_click_bubbles_once_and_scalar_attributes_are_not_native_disabled() {
    // Done-when: hit-tested Blitz pointer defaults reach JS clicks; generic
    // class/data/ARIA transport preserves false strings and stopPropagation.
    let mut doc = document();
    assert_eq!(
        attr(&doc, "activate", "aria-label").as_deref(),
        Some("Activate fixture")
    );
    assert_eq!(
        attr(&doc, "activate", "aria-pressed").as_deref(),
        Some("false")
    );
    assert_eq!(
        attr(&doc, "editor", "aria-disabled").as_deref(),
        Some("false")
    );
    assert_eq!(
        attr(&doc, "editor", "aria-invalid").as_deref(),
        Some("false")
    );
    assert_eq!(
        attr(&doc, "editor", "aria-describedby").as_deref(),
        Some("value")
    );
    assert_eq!(attr(&doc, "editor", "disabled"), None);
    pointer(&mut doc, "activate");
    assert_eq!(text(&doc, "count"), "1");
    assert_eq!(text(&doc, "bubbles"), "1");
    assert_eq!(text(&doc, "identity"), "true");
    // Button pointer focus is platform policy; Tab focus is asserted separately.
    assert_eq!(
        attr(&doc, "activate", "data-pressed").as_deref(),
        Some("true")
    );
    policy(&mut doc, false, false, false, true);
    pointer(&mut doc, "activate");
    assert_eq!(text(&doc, "count"), "2");
    assert_eq!(text(&doc, "bubbles"), "1");
    pointer(&mut doc, "blocked");
    assert_eq!(text(&doc, "count"), "2");
    assert!(doc.take_error().is_none());
}

#[test]
fn keyboard_activation_obeys_repeat_cancel_focus_and_composition() {
    // Real failure modes: upstream lacks button activation. The adapter must
    // synthesize exactly one click, never repeats, canceled keys or IME confirm.
    let mut doc = document();
    tab(&mut doc);
    assert_eq!(
        doc.inner().get_focussed_node_id(),
        Some(id(&doc, "activate"))
    );
    assert_eq!(text(&doc, "focus"), "activate");
    key(&mut doc, Key::Named(NamedKey::Enter), false, false);
    key(&mut doc, Key::Named(NamedKey::Enter), false, true);
    key(&mut doc, Key::Named(NamedKey::Enter), true, false);
    assert_eq!(text(&doc, "count"), "1");
    assert_eq!(text(&doc, "key"), "Enter:Enter:true:false");
    key(&mut doc, Key::Character(" ".into()), false, false);
    key(&mut doc, Key::Character(" ".into()), false, true);
    assert_eq!(text(&doc, "count"), "1");
    key(&mut doc, Key::Character(" ".into()), true, false);
    key(&mut doc, Key::Character(" ".into()), true, false);
    assert_eq!(text(&doc, "count"), "2");
    policy(&mut doc, false, false, true, false);
    key(&mut doc, Key::Named(NamedKey::Enter), false, false);
    key(&mut doc, Key::Character(" ".into()), false, false);
    key(&mut doc, Key::Character(" ".into()), true, false);
    assert_eq!(text(&doc, "count"), "2");
    policy(&mut doc, false, false, false, false);
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit(
        "候補".into(),
        Some((0, 6)),
    )));
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit(String::new(), None)));
    key(&mut doc, Key::Named(NamedKey::Enter), false, false);
    assert_eq!(text(&doc, "count"), "2");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Disabled));
    key(&mut doc, Key::Character(" ".into()), false, false);
    tab(&mut doc);
    key(&mut doc, Key::Character(" ".into()), true, false);
    assert_eq!(text(&doc, "count"), "2");
    assert_eq!(doc.inner().get_focussed_node_id(), Some(id(&doc, "editor")));
    assert!(doc.take_error().is_none());
}

#[test]
fn native_editor_input_apple_delete_ime_and_controlled_clear_follow_solid() {
    // Done-when: real Blitz editor defaults generate input events into Solid.
    // readonly/disabled/cancellation must stop edits before native defaults,
    // including Apple commands; aria-disabled=false must not block typing.
    let mut doc = document();
    pointer(&mut doc, "editor");
    assert_eq!(doc.inner().get_focussed_node_id(), Some(id(&doc, "editor")));
    assert_eq!(text(&doc, "focus"), "editor");
    key(&mut doc, Key::Character("a".into()), false, false);
    key(&mut doc, Key::Character("b".into()), false, false);
    assert_eq!(editor(&doc), "ab");
    assert_eq!(text(&doc, "value"), "ab");
    doc.handle_ui_event(UiEvent::AppleStandardKeybinding("deleteBackward:".into()));
    assert_eq!(editor(&doc), "a");
    assert_eq!(text(&doc, "value"), "a");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("日".into())));
    assert_eq!(editor(&doc), "a日");
    assert_eq!(text(&doc, "value"), "a日");
    host(&mut doc, "clear", Value::Null);
    assert_eq!(editor(&doc), "");
    assert_eq!(text(&doc, "value"), "");
    key(&mut doc, Key::Character("x".into()), false, false);
    for (disabled, readonly, cancel) in [
        (false, true, false),
        (true, false, false),
        (false, false, true),
    ] {
        policy(&mut doc, disabled, readonly, cancel, false);
        key(&mut doc, Key::Character("z".into()), false, false);
        doc.handle_ui_event(UiEvent::AppleStandardKeybinding("deleteBackward:".into()));
        doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("語".into())));
        assert_eq!(editor(&doc), "x", "policy {disabled}/{readonly}/{cancel}");
        assert_eq!(text(&doc, "value"), "x");
    }
    policy(&mut doc, true, false, false, false);
    tab(&mut doc);
    assert_ne!(doc.inner().get_focussed_node_id(), Some(id(&doc, "editor")));
    assert_eq!(text(&doc, "focus"), "none");
    assert!(doc.take_error().is_none());
}

#[test]
fn solid_reconciliation_moves_native_nodes_and_disposes_host_subscriptions() {
    // Done-when: a component tree, not a fixed demo patcher. Solid For moves
    // retained native identities, removes nodes, and Show retires subscriptions.
    let mut doc = document();
    let retained = id(&doc, "item-c");
    let removed = id(&doc, "item-b");
    host(&mut doc, "ping", Value::Null);
    assert_eq!(text(&doc, "deliveries"), "1");
    host(
        &mut doc,
        "tree",
        json!({"items":["c","a","d"],"visible":false}),
    );
    assert_eq!(text(&doc, "list"), "cad");
    assert_eq!(id(&doc, "item-c"), retained);
    let children = doc
        .inner()
        .get_node(id(&doc, "list"))
        .unwrap()
        .children
        .to_vec();
    assert!(!children.contains(&removed));
    host(&mut doc, "ping", Value::Null);
    assert_eq!(text(&doc, "deliveries"), "1");
    host(&mut doc, "tree", json!({"items":[],"visible":true}));
    assert_eq!(text(&doc, "list"), "");
    host(&mut doc, "ping", Value::Null);
    assert_eq!(text(&doc, "deliveries"), "2");
    assert!(doc.take_error().is_none());
}

#[test]
fn ready_jobs_and_mutations_before_a_throw_do_not_wait_for_another_event() {
    // Real failure mode: JS signal writes and ready Promise jobs must reach
    // native state before returning, even when a listener subsequently throws.
    let mut doc = document();
    host(&mut doc, "async", Value::Null);
    assert_eq!(text(&doc, "host"), "promise settled");
    pointer(&mut doc, "throw");
    assert_eq!(text(&doc, "host"), "before throw");
    assert!(
        doc.take_error()
            .unwrap()
            .to_string()
            .contains("fixture listener failure")
    );
    host(&mut doc, "update", json!({"label":"recovered","count":8}));
    assert_eq!(text(&doc, "host"), "recovered");
    assert!(doc.take_error().is_none());
}

#[test]
fn runaway_promise_jobs_are_bounded_instead_of_starving_the_event_loop() {
    // Real failure mode: a self-scheduling microtask queue must yield an error,
    // not hang paint or teardown. The implementation's job gate, not a sleep,
    // terminates this test; dropping the document must still retire its heap.
    let mut doc = document();
    let error = doc
        .host_event(doc.generation(), "spin", Value::Null)
        .unwrap_err();
    assert!(error.to_string().contains("microtask"), "{error}");
    drop(doc);
    assert_eq!(text(&document(), "host"), "idle");
}

#[test]
fn canceled_ime_composition_does_not_poison_later_button_activation() {
    // Regression: empty preedit is ambiguous until Escape cancels composition.
    // A later noncomposing Enter must work without requiring blur/IME disable.
    // Confirmation Enter suppression remains independently asserted above.
    let mut doc = document();
    tab(&mut doc);
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit(
        "候補".into(),
        Some((0, 6)),
    )));
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit(String::new(), None)));
    key(&mut doc, Key::Named(NamedKey::Escape), false, false);
    key(&mut doc, Key::Named(NamedKey::Escape), true, false);
    assert_eq!(text(&doc, "count"), "0");
    key(&mut doc, Key::Named(NamedKey::Enter), false, false);
    key(&mut doc, Key::Named(NamedKey::Enter), true, false);
    assert_eq!(
        text(&doc, "count"),
        "1",
        "Escape must retire canceled composition before normal Enter"
    );
    assert!(doc.take_error().is_none());
}

#[test]
fn rejected_mutation_batch_retires_generation_instead_of_accepting_desynced_updates() {
    // Regression: Solid has already advanced when the native wire rejects its
    // batch. Continuing to accept host/UI work can corrupt every later topology
    // update. Retire that generation; ordinary listener exceptions are NOT fatal
    // and their preceding valid mutations/recovery are tested separately.
    let mut doc = document();
    let (sender, _mailbox) = render::HostMailbox::new(&doc, || {});
    let huge = "x".repeat(4 * 1024 * 1024 + 1);
    let error = doc
        .host_event(
            doc.generation(),
            "tree",
            json!({"items":[huge],"visible":true}),
        )
        .unwrap_err();
    assert!(error.to_string().contains("4 MiB"), "{error}");
    let outcomes = [
        doc.host_event(
            doc.generation(),
            "tree",
            json!({"items":["small"],"visible":true}),
        ),
        doc.host_event(
            doc.generation(),
            "tree",
            json!({"items":[],"visible":false}),
        ),
        doc.host_event(
            doc.generation(),
            "update",
            json!({"label":"must not deliver","count":99}),
        ),
    ];
    assert!(
        outcomes.iter().all(|outcome| !matches!(outcome, Ok(true))),
        "fatal wire failure must reject all later delivery, not report an unrelated update as accepted: {outcomes:?}"
    );
    assert_eq!(text(&doc, "host"), "idle");
    assert_eq!(text(&doc, "count"), "0");
    assert!(
        sender.send("ping", Value::Null).is_err(),
        "fatal flush must close existing producer capabilities"
    );
}

#[test]
fn readonly_preserves_selection_copy_and_navigation_without_allowing_edits() {
    // Regression: readonly forbids mutations, not nonmutating editor commands.
    // The recording shell isolates clipboard writes from the real OS clipboard;
    // selection, navigation and copying still execute real Blitz/Parley defaults.
    #[derive(Default)]
    struct Clipboard(Mutex<String>);

    impl ShellProvider for Clipboard {
        fn set_clipboard_text(&self, text: String) -> Result<(), ClipboardError> {
            *self.0.lock().unwrap() = text;
            Ok(())
        }
    }
    let mut doc = document();
    let clipboard = Arc::new(Clipboard::default());
    doc.inner_mut().set_shell_provider(clipboard.clone());
    pointer(&mut doc, "editor");
    for ch in ["a", "b", "c"] {
        key(&mut doc, Key::Character(ch.into()), false, false);
    }
    policy(&mut doc, false, true, false, false);
    doc.handle_ui_event(UiEvent::AppleStandardKeybinding("selectAll:".into()));
    let selected = selected_editor_text(&doc);
    assert_eq!(
        selected.as_deref(),
        Some("abc"),
        "readonly must allow selectAll:"
    );
    let action = if cfg!(target_os = "macos") {
        Modifiers::META
    } else {
        Modifiers::CONTROL
    };
    modified_key(&mut doc, Key::Character("c".into()), false, false, action);
    assert_eq!(
        *clipboard.0.lock().unwrap(),
        "abc",
        "readonly must allow copy"
    );
    key(&mut doc, Key::Named(NamedKey::ArrowRight), false, false);
    let selected = selected_editor_text(&doc);
    assert_eq!(
        selected, None,
        "readonly must allow navigation to collapse selection"
    );
    doc.handle_ui_event(UiEvent::AppleStandardKeybinding(
        "moveLeftAndModifySelection:".into(),
    ));
    let selected = selected_editor_text(&doc);
    assert_eq!(
        selected.as_deref(),
        Some("c"),
        "readonly must allow Apple selection navigation"
    );
    doc.handle_ui_event(UiEvent::AppleStandardKeybinding("deleteBackward:".into()));
    assert_eq!(editor(&doc), "abc");
    assert_eq!(text(&doc, "value"), "abc");
    assert!(doc.take_error().is_none());
}

#[test]
fn production_bundler_handles_typed_tsx_and_checkout_paths_with_spaces() {
    // Regression: the acceptance fixture's Babel options cannot stand in for
    // the real product tool. Run that tool unmodified in isolated package roots,
    // then execute BOTH outputs in the real QuickJS native document.
    let output = std::process::Command::new("proto")
        .args(["run", "bun", "--", "tests/production-build.mjs"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "production bundler regressions:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let bundle = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/dist/tests/production-typed.js"
    ))
    .unwrap();
    let mut doc = NativeDocument::new(SHELL, &bundle).unwrap();
    assert_eq!(text(&doc, "typed"), "initial");
    host(
        &mut doc,
        "typed",
        json!({"label":"typed payload","count":42}),
    );
    assert_eq!(text(&doc, "typed"), "typed payload:42");
    let bundle = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/dist/tests/production-spaces.js"
    ))
    .unwrap();
    let mut doc = NativeDocument::new(SHELL, &bundle).unwrap();
    host(&mut doc, "tick", json!({"count":9}));
    assert_eq!(text(&doc, "host"), "Host ticks (no interaction needed): 9");
}

#[test]
fn actual_host_mailbox_bounds_floods_and_reschedules_one_wake_budget_at_a_time() {
    // Regression: the native shell's actual mailbox must reject overload, not
    // accept an unbounded producer flood or drain it all in one event-loop turn.
    // The producer finishes before consumption, so queue pressure/order is
    // deterministic; no timing sleeps or parallel fake queue are involved.
    use std::sync::atomic::{AtomicUsize, Ordering};
    let mut doc = document();
    let wakes = Arc::new(AtomicUsize::new(0));
    let wake_count = wakes.clone();
    let (sender, mut mailbox) = render::HostMailbox::new(&doc, move || {
        wake_count.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(sender.generation(), doc.generation());
    assert_eq!(mailbox.generation(), doc.generation());
    let producer = sender.clone();
    let (accepted, rejected) = thread::spawn(move || {
        let mut accepted = 0;
        let mut rejected = 0;
        for _ in 0..25_000 {
            match producer.send("ping", Value::Null) {
                Ok(()) => accepted += 1,
                Err(_) => rejected += 1,
            }
        }
        (accepted, rejected)
    })
    .join()
    .unwrap();
    assert!(
        accepted > 32 && accepted <= 256,
        "accepted {accepted} events without a consumer"
    );
    assert!(rejected > 0, "overload must be explicit to the producer");
    assert_eq!(mailbox.pending(), accepted);
    assert_eq!(
        text(&doc, "deliveries"),
        "0",
        "producer thread must not execute JS"
    );
    let before = wakes.load(Ordering::SeqCst);
    assert!(before > 0, "idle UI must receive a wake");
    let first = mailbox.drain(&mut doc).unwrap();
    assert!(
        (1..=32).contains(&first),
        "one wake delivered {first} events"
    );
    assert_eq!(text(&doc, "deliveries"), first.to_string());
    assert_eq!(mailbox.pending(), accepted - first);
    assert!(
        wakes.load(Ordering::SeqCst) > before,
        "remaining messages must schedule another wake"
    );
    let mut delivered = first;
    for _ in 0..accepted {
        if mailbox.pending() == 0 {
            break;
        }
        let count = mailbox.drain(&mut doc).unwrap();
        assert!((1..=32).contains(&count));
        delivered += count;
    }
    assert_eq!(mailbox.pending(), 0);
    assert_eq!(delivered, accepted);
    assert_eq!(text(&doc, "deliveries"), accepted.to_string());
    sender.send("ping", Value::Null).unwrap();
    assert_eq!(
        mailbox.drain(&mut doc).unwrap(),
        1,
        "capacity must recover after draining"
    );
    assert_eq!(text(&doc, "deliveries"), (accepted + 1).to_string());
}

#[test]
fn actual_host_mailbox_rejects_oversized_envelopes_and_aggregate_byte_overload() {
    // Regression: an event-count limit alone still permits large memory growth.
    // Exercise actual serialized JSON envelopes and aggregate queued byte limits
    // without involving the system clipboard, a window, or arbitrary JS handles.
    let doc = document();
    let (sender, mailbox) = render::HostMailbox::new(&doc, || {});
    assert!(sender.send("unused", "x".repeat(1024 * 1024 + 1)).is_err());
    assert_eq!(
        mailbox.pending(),
        0,
        "rejected envelope must not enter queue"
    );
    let payload = "x".repeat(48 * 1024);
    let mut accepted = 0;
    for _ in 0..256 {
        if sender.send("unused", &payload).is_err() {
            break;
        }
        accepted += 1;
    }
    assert!(
        (1..256).contains(&accepted),
        "byte pressure must reject before event-count limit, accepted {accepted}"
    );
    assert_eq!(mailbox.pending(), accepted);
    assert!(sender.send("unused", &payload).is_err());
    drop(mailbox);
    assert!(
        sender.send("unused", Value::Null).is_err(),
        "dropped consumer closes producer capability"
    );
}

#[test]
fn actual_host_mailbox_discards_stale_generation_and_closes_on_document_drop() {
    // Regression: a queued event for a closed/replaced document must never run
    // against a replacement heap. Verify the real sender/mailbox capabilities,
    // not just a manually supplied generation number at host_event.
    let original = document();
    let (sender, mut mailbox) = render::HostMailbox::new(&original, || {});
    sender.send("ping", Value::Null).unwrap();
    assert_eq!(mailbox.pending(), 1);
    let mut replacement = document();
    assert_ne!(mailbox.generation(), replacement.generation());
    assert_eq!(mailbox.drain(&mut replacement).unwrap(), 0);
    assert_eq!(mailbox.pending(), 0);
    assert_eq!(text(&replacement, "deliveries"), "0");
    drop(original);
    assert!(sender.send("ping", Value::Null).is_err());
    let (replacement_sender, replacement_mailbox) = render::HostMailbox::new(&replacement, || {});
    drop(replacement);
    assert!(replacement_sender.send("ping", Value::Null).is_err());
    drop(replacement_mailbox);
}

/// Layout reports (src/layout.rs): an observed element's box and visible
/// area reach JS after layout; a report that changes the document is laid
/// out before `resolve_layout` returns; nothing is reported while nothing
/// moves; scrolling and resizing are reported; stopping ends the reports.
#[test]
fn observed_layout_reaches_js_after_layout_and_only_when_it_changes() {
    let mut doc = document();
    let reports = |doc: &NativeDocument| text(doc, "reports").parse::<u32>().unwrap();
    let layout =
        |doc: &NativeDocument| serde_json::from_str::<Value>(&text(doc, "layout")).unwrap();
    let rect = |doc: &NativeDocument, name: &str| {
        doc.inner().get_client_bounding_rect(id(doc, name)).unwrap()
    };
    let close = |v: &Value, want: f64| (v.as_f64().unwrap() - want).abs() < 0.01;
    doc.resolve_layout(0.0);
    assert_eq!(reports(&doc), 0, "nothing observed, nothing reported");
    host(&mut doc, "observe", json!(true));
    doc.resolve_layout(0.0);
    assert_eq!(reports(&doc), 1);
    let clipper = rect(&doc, "clipper");
    let observed = rect(&doc, "observed");
    let got = layout(&doc);
    for (i, want) in [observed.x, observed.y, observed.width, observed.height]
        .iter()
        .enumerate()
    {
        assert!(
            close(&got["rect"][["x", "y", "width", "height"][i]], *want),
            "rect {got}"
        );
    }
    // The clip is the scroller's padding box (inside its 2 px border).
    let clip = &got["clip"];
    assert!(
        close(&clip["x"], clipper.x + 2.0) && close(&clip["y"], clipper.y + 2.0),
        "{clip}"
    );
    assert!(
        close(&clip["width"], clipper.width - 4.0) && close(&clip["height"], clipper.height - 4.0),
        "{clip}"
    );
    // The follower was sized from the report in the same call.
    assert_eq!(rect(&doc, "follower").width.round(), observed.y.round());
    // Idle: no further report.
    for _ in 0..3 {
        doc.resolve_layout(0.0);
    }
    assert_eq!(reports(&doc), 1, "unchanged layouts are not reported");
    // Scrolling the clipping ancestor moves the box.
    let scroller = id(&doc, "clipper");
    doc.inner_mut()
        .scroll_by(scroller, 0.0, 30.0, Default::default());
    doc.resolve_layout(0.0);
    assert_eq!(reports(&doc), 2);
    assert!(
        close(&layout(&doc)["rect"]["y"], observed.y - 30.0),
        "{}",
        layout(&doc)
    );
    // The scroller itself does not move: the clip stays.
    assert_eq!(layout(&doc)["clip"], got["clip"], "the clip stays");
    // A size change is reported.
    host(&mut doc, "tall", json!(true));
    doc.resolve_layout(0.0);
    assert_eq!(reports(&doc), 3);
    assert!(close(&layout(&doc)["rect"]["height"], 50.0));
    // A smaller window cuts the clip.
    let window = (clipper.y + 20.0) as u32;
    doc.inner_mut().set_viewport(Viewport {
        window_size: (800, window),
        ..Default::default()
    });
    doc.resolve_layout(0.0);
    assert_eq!(reports(&doc), 4);
    let clip = &layout(&doc)["clip"];
    let bottom = clip["y"].as_f64().unwrap() + clip["height"].as_f64().unwrap();
    assert_eq!(bottom, window as f64, "ends at the window's bottom: {clip}");
    // Stopped: the attribute is gone and nothing more is reported.
    host(&mut doc, "observe", json!(false));
    assert_eq!(attr(&doc, "observed", "tk-observe"), None);
    doc.inner_mut()
        .scroll_by(scroller, 0.0, -30.0, Default::default());
    doc.resolve_layout(0.0);
    assert_eq!(reports(&doc), 4);
    assert!(doc.take_error().is_none());
}

fn selected_editor_text(doc: &NativeDocument) -> Option<String> {
    doc.inner()
        .get_node(id(doc, "editor"))
        .unwrap()
        .element_data()
        .unwrap()
        .text_input_data()
        .unwrap()
        .editor
        .selected_text()
        .map(str::to_owned)
}
