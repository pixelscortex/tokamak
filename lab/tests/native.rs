//! The actual lab bundle on the production native controls, without a backend:
//! the `@tokamak/ui` components (Textarea, Select, Composer, Button) in the
//! lab's views, driven through Blitz with injected native events.
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;
use blitz_dom::Document;
use blitz_traits::{events::*, shell::Viewport};
use keyboard_types::{Code, Key, Location, Modifiers, NamedKey};
use render::NativeDocument;

/// The lab at `width` x `height` with the view `name` open (picked in the
/// plugin sidebar).
fn view_at(width: u32, height: u32, name: &str) -> NativeDocument {
    let mut doc = NativeDocument::new(
        include_str!("../dist/shell.html"),
        include_str!("../dist/ui.js"),
    )
    .unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: (width, height),
        ..Default::default()
    });
    doc.resolve_layout(0.0);
    support::pointer(&mut doc, &format!("lab-view-{name}"));
    doc.resolve_layout(0.0);
    doc
}

fn view(name: &str) -> NativeDocument {
    view_at(1440, 900, name)
}

/// Tab focus like `support::focus`, with room for the shell's top bar,
/// rail and sidebar controls, which come before the view's in tab order.
fn focus(doc: &mut NativeDocument, name: &str) {
    doc.resolve_layout(0.0);
    for _ in 0..96 {
        if doc.inner().get_focussed_node_id() == Some(support::id(doc, name)) {
            return;
        }
        support::key(doc, "Tab", false, false);
    }
    panic!("Tab could not focus {name}");
}

/// A key press (down, then up) on the focused element, with or without Shift.
fn press(doc: &mut NativeDocument, key: Key, shift: bool) {
    let code = match &key {
        Key::Named(NamedKey::Enter) => Code::Enter,
        Key::Named(NamedKey::Escape) => Code::Escape,
        Key::Named(NamedKey::ArrowDown) => Code::ArrowDown,
        Key::Named(NamedKey::ArrowUp) => Code::ArrowUp,
        Key::Named(NamedKey::Backspace) => Code::Backspace,
        _ => Code::KeyA,
    };
    for state in [KeyState::Pressed, KeyState::Released] {
        let event = BlitzKeyEvent {
            key: key.clone(),
            code,
            text: None,
            modifiers: if shift {
                Modifiers::SHIFT
            } else {
                Modifiers::empty()
            },
            location: Location::Standard,
            is_auto_repeating: false,
            is_composing: false,
            state,
        };
        doc.handle_ui_event(match state {
            KeyState::Pressed => UiEvent::KeyDown(event),
            KeyState::Released => UiEvent::KeyUp(event),
        });
    }
    doc.resolve_layout(0.0);
}

fn enter(doc: &mut NativeDocument, shift: bool) {
    press(doc, Key::Named(NamedKey::Enter), shift);
}

/// Text typed into the focused editor, as an IME commit (what a keyboard
/// layout or an input method delivers).
fn commit(doc: &mut NativeDocument, text: &str) {
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit(text.into())));
    doc.resolve_layout(0.0);
}

/// A pointer click on `name`, then the layout the next frame would see.
/// Click `name`, first scrolling the stage so it is in view: content
/// scrolled out of the stage takes no clicks.
fn click(doc: &mut NativeDocument, name: &str) {
    doc.resolve_layout(0.0);
    let stage = support::id(doc, "shell-stage");
    let (top, height, target) = {
        let inner = doc.inner();
        let view = inner.get_client_bounding_rect(stage).unwrap();
        // Blitz reports a scroller's box moved by its own scroll offset.
        let scrolled = inner.get_node(stage).unwrap().scroll_offset().y;
        (
            view.y + scrolled,
            view.height,
            inner
                .get_client_bounding_rect(support::id(doc, name))
                .unwrap(),
        )
    };
    let middle = target.y + target.height / 2.0;
    if middle < top || middle > top + height {
        let centre = top + height / 2.0;
        doc.inner_mut()
            .scroll_by(stage, 0.0, middle - centre, Default::default());
    }
    support::pointer(doc, name);
    doc.resolve_layout(0.0);
}

/// Delete the character before the caret. Blitz edits text with the
/// platform's own commands: on macOS Backspace arrives as `deleteBackward:`.
fn backspace(doc: &mut NativeDocument) {
    #[cfg(target_os = "macos")]
    doc.handle_ui_event(UiEvent::AppleStandardKeybinding("deleteBackward:".into()));
    #[cfg(not(target_os = "macos"))]
    press(doc, Key::Named(NamedKey::Backspace), false);
    doc.resolve_layout(0.0);
}

fn exists(doc: &NativeDocument, name: &str) -> bool {
    doc.inner().get_element_by_id(name).is_some()
}

/// One line of the composer's text (Textarea `md`), CSS px.
const LINE: f32 = 24.0;

/// The textarea starts one line tall, grows one line per line of text
/// (hard breaks and soft wraps alike), stops at `maxRows` (8) and keeps
/// every line, scrolling inside.
#[test]
fn the_textarea_grows_line_by_line_and_stops_at_its_limit() {
    let mut doc = view("chat");
    let input = "lab-chat-composer-input";
    let height = |doc: &NativeDocument| rect(doc, input).height as f32;
    assert_eq!(height(&doc), LINE, "empty: one line");
    click(&mut doc, input);
    commit(&mut doc, "one");
    assert_eq!(height(&doc), LINE);
    for lines in 2..=8 {
        enter(&mut doc, true);
        commit(&mut doc, &format!("line {lines}"));
        assert_eq!(height(&doc), LINE * lines as f32, "{lines} lines");
    }
    for _ in 0..4 {
        enter(&mut doc, true);
        commit(&mut doc, "more");
    }
    assert_eq!(height(&doc), LINE * 8.0, "stops at maxRows");
    assert_eq!(
        support::editor(&doc, input).lines().count(),
        12,
        "the text is all there"
    );
    // A long line wraps, and each wrapped line counts.
    let mut doc = view("composer");
    click(&mut doc, "lab-idle-input");
    commit(&mut doc, &"wrapping words ".repeat(30));
    let wrapped = rect(&doc, "lab-idle-input").height as f32;
    assert!(wrapped >= LINE * 3.0 && wrapped <= LINE * 8.0, "{wrapped}");
    assert_eq!(wrapped % LINE, 0.0, "whole lines: {wrapped}");
    assert!(doc.take_error().is_none());
}

/// Enter sends the text (and clears it); Shift+Enter adds a line.
#[test]
fn enter_submits_and_shift_enter_adds_a_line() {
    let mut doc = view("chat");
    let input = "lab-chat-composer-input";
    click(&mut doc, input);
    commit(&mut doc, "hello");
    enter(&mut doc, true);
    commit(&mut doc, "world");
    assert_eq!(support::editor(&doc, input), "hello\nworld");
    assert!(!exists(&doc, "lab-chat-sent-0"));
    enter(&mut doc, false);
    assert_eq!(support::text(&doc, "lab-chat-sent-0"), "hello\nworld");
    assert_eq!(support::editor(&doc, input), "", "cleared after sending");
    // Enter on an empty composer sends nothing.
    enter(&mut doc, false);
    assert!(!exists(&doc, "lab-chat-sent-1"));
    assert!(doc.take_error().is_none());
}

/// The send button is dim and inert until there is text (not just spaces).
#[test]
fn the_send_button_enables_with_text() {
    let mut doc = view("chat");
    let send = "lab-chat-composer-send";
    let disabled = |doc: &NativeDocument| support::attr(doc, send, "disabled").is_some();
    assert!(disabled(&doc));
    click(&mut doc, send);
    assert!(
        !exists(&doc, "lab-chat-sent-0"),
        "a disabled send sends nothing"
    );
    click(&mut doc, "lab-chat-composer-input");
    commit(&mut doc, "   ");
    assert!(disabled(&doc), "spaces are not text");
    commit(&mut doc, "milk");
    assert!(!disabled(&doc));
    click(&mut doc, send);
    assert_eq!(support::text(&doc, "lab-chat-sent-0"), "   milk");
    assert!(disabled(&doc), "empty again");
    assert!(doc.take_error().is_none());
}

/// The select opens from its trigger, moves over enabled options with Up
/// and Down, picks with Enter or a click, and closes on Escape and on a
/// click outside it.
#[test]
fn the_select_opens_moves_picks_and_closes() {
    let mut doc = view("select");
    let menu = "lab-select-field-menu";
    let value = |doc: &NativeDocument| support::text(doc, "lab-select-field-value");
    let active = |doc: &NativeDocument, i: usize| {
        support::attr(doc, &format!("lab-select-field-option-{i}"), "data-active").is_some()
    };
    assert!(!exists(&doc, menu));
    // Pointer: open, then pick an option.
    click(&mut doc, "lab-select-field");
    assert!(exists(&doc, menu));
    assert_eq!(
        support::attr(&doc, "lab-select-field", "aria-expanded").as_deref(),
        Some("true")
    );
    let (trigger, sheet) = (rect(&doc, "lab-select-field"), rect(&doc, menu));
    assert_eq!(
        sheet.y - (trigger.y + trigger.height),
        GAP,
        "below the trigger, 6 px apart: {trigger:?} {sheet:?}"
    );
    click(&mut doc, "lab-select-field-option-1");
    assert_eq!(value(&doc), "today");
    assert!(!exists(&doc, menu), "a pick closes it");
    // Keyboard: Enter opens on the focused trigger, Down moves (skipping
    // the disabled option 3), Up moves back, Enter picks.
    focus(&mut doc, "lab-select-field");
    enter(&mut doc, false);
    assert!(exists(&doc, menu));
    assert!(active(&doc, 1), "starts on the selected option");
    press(&mut doc, Key::Named(NamedKey::ArrowDown), false);
    assert!(active(&doc, 2));
    press(&mut doc, Key::Named(NamedKey::ArrowDown), false);
    assert!(active(&doc, 4), "the disabled option is skipped");
    press(&mut doc, Key::Named(NamedKey::ArrowUp), false);
    assert!(active(&doc, 2));
    enter(&mut doc, false);
    assert_eq!(value(&doc), "groceries");
    assert!(!exists(&doc, menu));
    // Down also opens; Escape closes without picking.
    press(&mut doc, Key::Named(NamedKey::ArrowDown), false);
    assert!(exists(&doc, menu));
    press(&mut doc, Key::Named(NamedKey::Escape), false);
    assert!(!exists(&doc, menu));
    assert_eq!(value(&doc), "groceries");
    // A click outside closes it; a click inside (a disabled option) does not.
    click(&mut doc, "lab-select-field");
    click(&mut doc, "lab-select-field-option-3");
    assert!(exists(&doc, menu), "a disabled option is not picked");
    assert_eq!(value(&doc), "groceries");
    click(&mut doc, "lab-select-field-value");
    assert!(!exists(&doc, menu), "closed by a click outside");
    assert!(doc.take_error().is_none());
}

/// The open select starts open, filters with its search field (typed into
/// the field, or on the focused trigger), and the upward one opens above
/// its trigger.
#[test]
fn the_select_searches_and_opens_upward() {
    let mut doc = view("select");
    assert!(exists(&doc, "lab-select-open-menu"), "starts open");
    click(&mut doc, "lab-select-open-search");
    commit(&mut doc, "rec");
    assert!(exists(&doc, "lab-select-open-option-5"));
    for hidden in [0, 1, 2, 4] {
        assert!(
            !exists(&doc, &format!("lab-select-open-option-{hidden}")),
            "{hidden}"
        );
    }
    enter(&mut doc, false);
    assert_eq!(support::text(&doc, "lab-select-open-value"), "receipts");
    assert!(!exists(&doc, "lab-select-open-menu"));
    // The compact select (models) filters by typing on its trigger.
    focus(&mut doc, "lab-select-compact");
    enter(&mut doc, false);
    assert!(exists(&doc, "lab-select-compact-menu"));
    for key in ["q", "w"] {
        press(&mut doc, Key::Character(key.into()), false);
    }
    assert_eq!(support::editor(&doc, "lab-select-compact-search"), "qw");
    assert!(exists(&doc, "lab-select-compact-option-6"), "local/qwen-4");
    assert!(!exists(&doc, "lab-select-compact-option-0"));
    enter(&mut doc, false);
    assert_eq!(
        support::text(&doc, "lab-select-compact-value"),
        "local/qwen-4"
    );
    // Upward.
    click(&mut doc, "lab-select-up");
    let (trigger, sheet) = (
        rect(&doc, "lab-select-up"),
        rect(&doc, "lab-select-up-menu"),
    );
    assert_eq!(
        trigger.y - (sheet.y + sheet.height),
        GAP,
        "above the trigger, 6 px apart: {trigger:?} {sheet:?}"
    );
    // A disabled select does not open.
    click(&mut doc, "lab-select-disabled");
    assert!(!exists(&doc, "lab-select-disabled-menu"));
    assert!(doc.take_error().is_none());
}

/// The gap between a select's trigger and its menu, bridged (CSS px).
const GAP: f64 = 6.0;

/// The rect of the first element matching `selector`.
fn rect_of(doc: &NativeDocument, selector: &str) -> blitz_dom::BoundingRect {
    let inner = doc.inner();
    let id = inner.query_selector(selector).unwrap().expect(selector);
    inner.get_client_bounding_rect(id).unwrap()
}

/// A select opens on the side that has room, measured inside its clipping
/// ancestor: one at the bottom of a short scrolling box opens upward by
/// itself, stays inside the box, and its height is limited to the room
/// above (the list scrolls inside); one with room below opens downward.
#[test]
fn the_select_opens_on_the_side_with_room() {
    let mut doc = view("select");
    let (trigger, menu, area) = (
        rect(&doc, "lab-select-flip"),
        rect(&doc, "lab-select-flip-menu"),
        rect(&doc, "lab-select-flip-box"),
    );
    assert_eq!(
        trigger.y - (menu.y + menu.height),
        GAP,
        "opened upward by itself: {trigger:?} {menu:?}"
    );
    // The room above: from 8 px inside the box's top to 6 px above the trigger.
    let room = trigger.y - GAP - (area.y + 8.0);
    assert!(
        menu.y >= area.y + 8.0 - 0.01,
        "inside the box: {menu:?} {area:?}"
    );
    assert!(
        (menu.height - room).abs() < 0.01,
        "as tall as the room: {menu:?}, room {room}"
    );
    let list = rect_of(&doc, "#lab-select-flip-menu [role=listbox]");
    let rows = rect_of(&doc, "#lab-select-flip-menu [role=listbox] > div");
    assert!(
        rows.height > list.height,
        "the list scrolls inside: {rows:?} in {list:?}"
    );
    // Its options still pick (the first one is in view).
    click(&mut doc, "lab-select-flip-option-0");
    assert_eq!(support::text(&doc, "lab-select-flip-value"), "inbox");
    assert!(!exists(&doc, "lab-select-flip-menu"));
    // With room below, the default side.
    click(&mut doc, "lab-select-field");
    let (trigger, menu) = (
        rect(&doc, "lab-select-field"),
        rect(&doc, "lab-select-field-menu"),
    );
    assert_eq!(menu.y - (trigger.y + trigger.height), GAP, "below");
    assert!(doc.take_error().is_none());
}

/// An open select is placed again when its room changes: a window resize
/// that leaves no room below flips it upward, and scrolling the stage so
/// an upward menu has no room above flips it down.
#[test]
fn an_open_select_is_placed_again_on_resize_and_scroll() {
    let mut doc = view("select");
    click(&mut doc, "lab-select-field");
    let trigger = rect(&doc, "lab-select-field");
    let below = rect(&doc, "lab-select-field-menu");
    assert_eq!(below.y - (trigger.y + trigger.height), GAP);
    // A window that ends 60 px below the trigger.
    doc.inner_mut().set_viewport(Viewport {
        window_size: (1440, (trigger.y + trigger.height + 60.0) as u32),
        ..Default::default()
    });
    doc.resolve_layout(0.0);
    let trigger = rect(&doc, "lab-select-field");
    let menu = rect(&doc, "lab-select-field-menu");
    assert_eq!(
        trigger.y - (menu.y + menu.height),
        GAP,
        "flipped above on resize: {trigger:?} {menu:?}"
    );
    // The upward select (open from the start), scrolled to the top of a
    // short stage: no room above it any more, so it opens below.
    let mut doc = view_at(1440, min_window().1, "select");
    let (trigger, menu) = (
        rect(&doc, "lab-select-up"),
        rect(&doc, "lab-select-up-menu"),
    );
    assert_eq!(
        trigger.y - (menu.y + menu.height),
        GAP,
        "above, as preferred"
    );
    let stage = support::id(&doc, "shell-stage");
    let top = rect(&doc, "shell-stage").y;
    doc.inner_mut()
        .scroll_by(stage, 0.0, trigger.y - top - 20.0, Default::default());
    doc.resolve_layout(0.0);
    let (trigger, menu) = (
        rect(&doc, "lab-select-up"),
        rect(&doc, "lab-select-up-menu"),
    );
    assert!(trigger.y - top < 60.0, "scrolled near the top: {trigger:?}");
    assert_eq!(
        menu.y - (trigger.y + trigger.height),
        GAP,
        "flipped below on scroll: {trigger:?} {menu:?}"
    );
    assert!(doc.take_error().is_none());
}

/// Each composer state shows its parts and works: idle, context chips
/// with "+N more", the running shelf with stop, the command list, the
/// command form and the approval.
#[test]
fn the_composer_shows_each_state() {
    let mut doc = view("composer");
    let note = |doc: &NativeDocument, id: &str| support::text(doc, &format!("lab-state-{id}-note"));
    // Idle: nothing above the text, send dim.
    assert!(support::attr(&doc, "lab-idle-send", "disabled").is_some());
    assert!(exists(&doc, "lab-idle-model"));
    // Context: six chips, then "+3 more", in at most two rows.
    for i in 0..6 {
        assert!(exists(&doc, &format!("lab-context-chip-{i}")), "chip {i}");
    }
    assert!(!exists(&doc, "lab-context-chip-6"));
    assert_eq!(support::text(&doc, "lab-context-more"), "+3 more");
    let first = rect(&doc, "lab-context-chip-0");
    let more = rect(&doc, "lab-context-more");
    assert!(more.y - first.y <= 30.5, "two rows at most");
    click(&mut doc, "lab-context-chip-0-remove");
    assert_eq!(
        support::text(&doc, "lab-context-more"),
        "+2 more",
        "removed one"
    );
    // Running: the shelf, stop instead of send.
    let status = support::text(&doc, "lab-running-status");
    for part in [
        "Reading Weekend groceries",
        "2/5",
        "14s",
        "and add oat milk too",
    ] {
        assert!(status.contains(part), "{part} in {status:?}");
    }
    assert!(!exists(&doc, "lab-running-send"));
    click(&mut doc, "lab-running-stop");
    assert_eq!(note(&doc, "running"), "stopped");
    // Commands: "/" lists all eight, six rows tall, then it scrolls.
    assert!(exists(&doc, "lab-commands-command-7"));
    assert_eq!(
        rect(&doc, "lab-commands-commands").height,
        180.0,
        "six 30 px rows"
    );
    click(&mut doc, "lab-commands-input");
    commit(&mut doc, "re");
    assert!(exists(&doc, "lab-commands-command-0"));
    assert!(!exists(&doc, "lab-commands-command-1"), "only /remind");
    assert!(support::text(&doc, "lab-commands-command-0").contains("/remind"));
    press(&mut doc, Key::Named(NamedKey::Escape), false);
    assert!(
        !exists(&doc, "lab-commands-commands"),
        "Escape closes the list"
    );
    // Back to "/": Down, Enter picks the second command and clears the text.
    backspace(&mut doc);
    backspace(&mut doc);
    assert_eq!(support::editor(&doc, "lab-commands-input"), "/");
    assert!(exists(&doc, "lab-commands-commands"), "the list is back");
    press(&mut doc, Key::Named(NamedKey::ArrowDown), false);
    assert!(support::attr(&doc, "lab-commands-command-1", "data-active").is_some());
    enter(&mut doc, false);
    assert_eq!(note(&doc, "commands"), "picked: /today");
    assert_eq!(support::editor(&doc, "lab-commands-input"), "");
    assert!(!exists(&doc, "lab-commands-commands"));
    // Command form: the tag, its selects, the text as title, Create.
    assert!(support::text(&doc, "lab-form-form").contains("/todo"));
    assert!(exists(&doc, "lab-form-field-due"));
    assert!(!exists(&doc, "lab-form-send") && !exists(&doc, "lab-form-model"));
    click(&mut doc, "lab-form-field-due");
    click(&mut doc, "lab-form-field-due-option-3");
    click(&mut doc, "lab-form-input");
    commit(&mut doc, "Oat milk");
    click(&mut doc, "lab-form-submit");
    assert_eq!(note(&doc, "form"), "created: Oat milk (inbox, next-week)");
    // Approval.
    assert!(support::text(&doc, "lab-state-approval").contains("Todo wants to add a task"));
    click(&mut doc, "lab-approval-always");
    assert_eq!(note(&doc, "approval"), "always allowed");
    click(&mut doc, "lab-approval-allow");
    assert_eq!(note(&doc, "approval"), "allowed once");
    click(&mut doc, "lab-approval-deny");
    assert_eq!(note(&doc, "approval"), "denied");
    assert!(doc.take_error().is_none());
}

/// The docked composer never takes more than 60% of the stage: on a short
/// window the text gives up lines first (the chips and footer keep theirs).
/// On a tall window the same text keeps all eight lines.
#[test]
fn the_composer_stays_within_60_percent_of_the_stage() {
    let (min_width, min_height) = min_window();
    for (height, room) in [(900, true), (min_height, false)] {
        let mut doc = view_at(min_width.max(1100), height, "chat");
        click(&mut doc, "lab-chat-composer-input");
        commit(&mut doc, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");
        let stage = panel(&doc);
        let composer = rect(&doc, "lab-chat-composer");
        let text = rect(&doc, "lab-chat-composer-input").height as f32;
        assert!(
            composer.height <= stage.height * 0.6 + 1.0,
            "{height}: {composer:?} in {stage:?}"
        );
        if room {
            assert_eq!(text, LINE * 8.0, "{height}: all eight lines");
        } else {
            assert!(
                text < LINE * 8.0 && text >= LINE,
                "{height}: the text gave up lines ({text})"
            );
            let chip = rect(&doc, "lab-chat-composer-chip-0");
            assert_eq!(chip.height, 24.0, "{height}: chips keep their size");
            assert!(chip.y >= composer.y, "{height}: the chips stay inside");
        }
        // The command list too.
        let mut doc = view_at(min_width, height, "chat");
        click(&mut doc, "lab-chat-composer-input");
        commit(&mut doc, "/");
        let stage = panel(&doc);
        let composer = rect(&doc, "lab-chat-composer");
        assert!(exists(&doc, "lab-chat-composer-commands"));
        assert!(
            composer.height <= stage.height * 0.6 + 1.0,
            "{height} commands: {composer:?} in {stage:?}"
        );
        assert!(doc.take_error().is_none());
    }
}

/// The stage panel: the scroller (`shell-stage`) plus the 1 px it keeps
/// clear of the panel's top and bottom edge.
fn panel(doc: &NativeDocument) -> blitz_dom::BoundingRect {
    let mut r = rect(doc, "shell-stage");
    r.y -= 1.0;
    r.height += 2.0;
    r
}

/// `/todo` in the chat opens its form; Create sends the task line.
#[test]
fn a_chat_command_opens_its_form() {
    let mut doc = view("chat");
    click(&mut doc, "lab-chat-composer-input");
    commit(&mut doc, "/to");
    assert!(support::text(&doc, "lab-chat-composer-command-0").contains("/todo"));
    enter(&mut doc, false);
    assert!(support::text(&doc, "lab-chat-composer-form").contains("/todo"));
    commit(&mut doc, "Buy oat milk");
    enter(&mut doc, false);
    assert_eq!(support::text(&doc, "lab-chat-sent-0"), "/todo Buy oat milk");
    assert!(!exists(&doc, "lab-chat-composer-form"), "the form closed");
    assert!(exists(&doc, "lab-chat-composer-send"));
    assert!(doc.take_error().is_none());
}

/// Buttons: the live one counts presses, the disabled one does not, and a
/// toggle reports its state.
#[test]
fn buttons_press_toggle_and_stay_inert_when_disabled() {
    let mut doc = view("buttons");
    click(&mut doc, "lab-button-primary-live");
    focus(&mut doc, "lab-button-neutral-live");
    enter(&mut doc, false);
    assert_eq!(support::text(&doc, "lab-button-presses"), "2 presses");
    click(&mut doc, "lab-button-primary-disabled");
    assert_eq!(support::text(&doc, "lab-button-presses"), "2 presses");
    assert_eq!(
        support::attr(&doc, "lab-button-toggle", "aria-pressed").as_deref(),
        Some("false")
    );
    click(&mut doc, "lab-button-toggle");
    assert_eq!(
        support::attr(&doc, "lab-button-toggle", "aria-pressed").as_deref(),
        Some("true")
    );
    click(&mut doc, "lab-chip-1-remove");
    assert!(!support::text(&doc, "lab-chips").contains("lease-2026.pdf"));
    assert!(doc.take_error().is_none());
}

/// The lab window's minimum size (app.config.json `minWidth`/`minHeight`).
fn min_window() -> (u32, u32) {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../app.config.json")).unwrap();
    let get = |key: &str| config[key].as_u64().unwrap() as u32;
    (get("minWidth"), get("minHeight"))
}

fn rect(doc: &NativeDocument, name: &str) -> blitz_dom::BoundingRect {
    doc.inner()
        .get_client_bounding_rect(support::id(doc, name))
        .unwrap()
}

/// Chat at wide to minimum widths: the reading column shrinks with the
/// stage and never runs into the context column (which gets out of the way
/// below a 1200 px window), and the title notch and composer follow the
/// column, their fused shapes (fillets, the notch's slant) staying inside
/// the stage. Nothing in the top bar or the plugin sidebar overlaps.
#[test]
fn chat_fits_wide_and_narrow_stages() {
    let (min_width, min_height) = min_window();
    let mut doc = view("chat");
    for (width, height) in [
        (1440, 900),
        (1100, 900),
        (900, 900),
        (min_width, min_height),
    ] {
        doc.inner_mut().set_viewport(Viewport {
            window_size: (width, height),
            ..Default::default()
        });
        doc.resolve_layout(0.0);
        let stage = rect(&doc, "shell-stage");
        let column = rect(&doc, "lab-chat-column");
        let context = rect(&doc, "lab-chat-context");
        let shown = context.width > 0.0;
        assert_eq!(shown, width >= 1200, "{width}: context column shown");
        for name in ["lab-chat-bubble", "lab-chat-card", "lab-chat-reply"] {
            let r = rect(&doc, name);
            assert!(
                r.x >= column.x - 0.5 && r.x + r.width <= column.x + column.width + 0.5,
                "{width}: {name} {r:?} outside the column {column:?}"
            );
            if shown {
                assert!(
                    r.x + r.width <= context.x,
                    "{width}: {name} {r:?} runs into the context column {context:?}"
                );
            }
        }
        assert!(
            column.width <= 640.0 && column.width > 300.0,
            "{width}: {column:?}"
        );
        // Fused shapes: the composer's fillets reach 22 px beyond its box,
        // the notch's slant 40 * tan(22 deg) ~ 16 px plus its 14 px fillet.
        for (name, reach) in [("lab-chat-composer", 22.0), ("lab-chat-notch", 31.0)] {
            let r = rect(&doc, name);
            assert!(
                r.x - reach >= stage.x && r.x + r.width + reach <= stage.x + stage.width,
                "{width}: {name} {r:?} (+{reach}) leaves the stage {stage:?}"
            );
            assert!(
                r.x >= column.x - 16.5 && r.x + r.width <= column.x + column.width + 0.5,
                "{width}: {name} {r:?} detached from the column {column:?}"
            );
        }
        // The plugin sidebar keeps its 220 px; the stage starts after it.
        let title = rect(&doc, "lab-chat-title");
        assert!(title.width > 40.0, "{width}: the title stays readable");
        // Top bar: start, search and end actions side by side.
        let search = rect(&doc, "lab-search");
        let toggle = rect(&doc, "lab-chat-context-toggle");
        let back = rect(&doc, "lab-back");
        assert!(
            back.x + back.width <= search.x,
            "{width}: {back:?} {search:?}"
        );
        assert!(
            search.x + search.width <= toggle.x,
            "{width}: {search:?} {toggle:?}"
        );
    }
    // The panel toggle hides the context column on a wide window too.
    doc.inner_mut().set_viewport(Viewport {
        window_size: (1440, 900),
        ..Default::default()
    });
    doc.resolve_layout(0.0);
    support::pointer(&mut doc, "lab-chat-context-toggle");
    doc.resolve_layout(0.0);
    assert_eq!(rect(&doc, "lab-chat-context").width, 0.0);
    assert!(doc.take_error().is_none());
}

/// The gallery views fit the stage at wide and narrow windows: every
/// composer state and the button grid stay inside it.
#[test]
fn views_fit_wide_and_narrow_stages() {
    for width in [1440, 1100, min_window().0] {
        for (view, parts) in [
            (
                "composer",
                &[
                    "lab-idle",
                    "lab-context",
                    "lab-running",
                    "lab-commands",
                    "lab-form",
                    "lab-approval",
                ][..],
            ),
            ("select", &["lab-select-field", "lab-select-open-menu"][..]),
            ("buttons", &["lab-chips", "lab-kbd"][..]),
        ] {
            let doc = view_at(width, 900, view);
            let stage = rect(&doc, "shell-stage");
            for name in parts {
                let r = rect(&doc, name);
                assert!(
                    r.x >= stage.x && r.x + r.width <= stage.x + stage.width + 1.0,
                    "{width} {view}: {name} {r:?} outside {stage:?}"
                );
            }
        }
    }
}

/// The native window's base colour (shown while a resize catches up) is the
/// theme's `--color-base`.
#[test]
fn window_base_colour_matches_the_theme_token() {
    let theme = include_str!("../../packages/ui/src/theme.css");
    let main = include_str!("../src/main.rs");
    let token = theme
        .lines()
        .find_map(|l| l.trim().strip_prefix("--color-base: #"))
        .and_then(|v| v.strip_suffix(';'))
        .unwrap();
    assert!(
        main.contains(&format!("WINDOW_BASE: u32 = 0x{token};")),
        "lab/src/main.rs WINDOW_BASE must equal --color-base #{token}"
    );
}

/// The native window buttons are placed from the shell's top bar metrics.
#[test]
fn window_buttons_follow_the_shell_top_bar() {
    let shell = include_str!("../../packages/ui/src/components/shell.tsx");
    let main = include_str!("../src/main.rs");
    let block = &shell[shell.find("export const topBar = {").unwrap()..];
    let value = |key: &str| -> String {
        let at = block.find(&format!("{key}: ")).unwrap() + key.len() + 2;
        block[at..].split(',').next().unwrap().trim().to_string()
    };
    let (height, left) = (value("height"), value("left"));
    assert!(
        main.contains(&format!("TOP_BAR: (f64, f64) = ({height}.0, {left}.0);")),
        "lab/src/main.rs TOP_BAR must equal topBar.height {height} and topBar.left {left}"
    );
}

#[test]
fn views_teleport_into_the_shell_regions() {
    let mut doc = view("chat");
    let title = |doc: &NativeDocument| doc.inner().get_element_by_id("lab-chat-title").is_some();
    assert!(title(&doc), "the chat view starts open");
    assert!(doc.inner().get_element_by_id("lab-chat-composer").is_some());
    let stage = support::id(&doc, "shell-stage");
    click(&mut doc, "lab-view-buttons");
    assert!(!title(&doc), "the chat title left the top bar");
    assert!(
        doc.inner().get_element_by_id("lab-chat-composer").is_none(),
        "the composer left the bottom bar"
    );
    assert!(support::text(&doc, "lab-buttons").contains("Variants and states"));
    assert_eq!(
        stage,
        support::id(&doc, "shell-stage"),
        "the frame's stage is the same element"
    );
    // The chat view's content lives in the stage region, not where the view is.
    let lab = support::id(&doc, "lab-buttons");
    assert!(doc.inner().node_chain(lab).contains(&stage));
    click(&mut doc, "lab-view-chat");
    assert!(title(&doc));
    assert!(doc.take_error().is_none());
}

#[test]
fn the_stage_scroller_owns_its_content_paint_order() {
    let doc = view("surfaces");
    assert!(
        doc.inner()
            .get_node(support::id(&doc, "shell-stage"))
            .unwrap()
            .is_stacking_context_root(false)
    );
}
