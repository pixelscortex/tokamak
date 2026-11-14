# Native renderer

`render` runs a Solid TypeScript UI in QuickJS and draws its native document with
Blitz and Vello/wgpu. JS and Blitz stay on the window event-loop thread; host
workers exchange owned JSON through a bounded, generation-scoped mailbox.

The root Cargo manifest patches Blitz to the pinned Tokamak fork so a custom
widget can ignore an event and let the element’s default action run. See
[BLITZ_FORK.md](BLITZ_FORK.md), [BLITZ_CHANGES.md](BLITZ_CHANGES.md) and
[SURFACES.md](SURFACES.md) for the surface renderer’s contracts and limitations.
QuickJS’s heap ceiling defaults to half of physical memory, with a 256 MiB floor
and a 4 GiB fallback when memory size is unknown; `TOKAMAK_UI_HEAP_BYTES` overrides it.

## Public API

- `NativeDocument::new` / `new_connected` mount a shell containing `#app` and a
  compiled bundle. `new_connected` accepts a `MessageSender` for outward JSON.
- `generation` and `host_event` support embedder-owned delivery. A mismatched
  generation returns `Ok(false)`; dropping or retiring a document invalidates its senders.
- `HostMailbox::new` supplies a `HostSender` and a receiver. Send means queued;
  `drain` processes bounded work. `finish` reserves terminal delivery after queued events.
- `launch` opens the default window; `launch_connected` also installs outward
  admission; `launch_window_with` accepts size and `WindowOptions` (including
  `TrafficLights`). The connect callback receives a host sender and must not block.
- Headless embedders use Blitz’s `Document` trait, call `resolve_layout`, then
  `layout_surfaces` before painting, and `surface_end_frame` after `paint_scene`.
  `take_error` returns deferred UI errors. `lab-probes` exposes shape and paint probes.
- `Error`, `Result`, `MessageSender` and `MAX_WIRE_MESSAGE_BYTES` are exported at the crate root.
- [`@tokamak/render`](js/index.ts) exports the universal JSX runtime, `mount`,
  `onHostEvent` and `observeLayout`. Events cancel synchronously; layout reports
  arrive after layout rather than through synchronous DOM measurements.

## Blitz workarounds

| Workaround | Implementation |
| --- | --- |
| Button Enter/Space activation, including repeats, focus and cancellation. | [`src/input.rs:156`](src/input.rs#L156) |
| Disabled and readonly text fields cancel editing before Blitz defaults run. | [`src/input.rs:126`](src/input.rs#L126) |
| Empty IME preedit can mean commit or cancellation; track that gap until a definitive event. | [`src/input.rs:13`](src/input.rs#L13) |
| Apple commands bypass the upstream UI event handler; route them through the DOM driver. | [`src/document.rs:173`](src/document.rs#L173) |
| Forward macOS editing bindings to Blitz. | [`src/shell.rs:288`](src/shell.rs#L288) |
| Enable the missing IME cursor-area capability. | [`src/shell.rs:340`](src/shell.rs#L340) |
| Blitz chains unused wheel deltas; overscroll-contain consumes them within the marked scroller. | [`src/input.rs:282`](src/input.rs#L282) |
| Report measurements after layout and resolve again when JS placement changes the tree. | [`src/document.rs:74`](src/document.rs#L74) |
| Blitz subtracts a scroller’s own offset from its client rect; add it back. | [`src/layout.rs:147`](src/layout.rs#L147) |
| Host mailbox wakeups must execute JS and flush mutations; requesting redraw alone does neither. | [`src/shell.rs:220`](src/shell.rs#L220) |
| Keep late Metal frames unscaled during live resize and colour the uncovered strip. | [`src/macos.rs:38`](src/macos.rs#L38) |
| AppKit offers no traffic-light position setting; place the native button container. | [`src/macos.rs:146`](src/macos.rs#L146) |
| Draw icon paths with kurbo/Vello without enabling Blitz’s full SVG parser stack. | [`src/icon.rs:22`](src/icon.rs#L22) |
| Elements with built-in node data cannot carry plate widgets; use an ancestor or sheet. | [`src/surface/bind.rs:751`](src/surface/bind.rs#L751) |
| Attach plate widgets after insertion so Blitz still initializes the element’s built-in state. | [`src/surface/bind.rs:781`](src/surface/bind.rs#L781) |
| Background custom widgets must pass hit testing through to their controls. | [`src/surface/mod.rs:60`](src/surface/mod.rs#L60) |

## Checks

From the repository root, using the pinned Proto/Moon tools:

```sh
proto run bun -- install --frozen-lockfile
moon run render:check render:test lab:test app:test
cargo check --workspace --all-targets --locked
```

Moon builds the demo, generated UI styles, lab frontend, app fixtures and server
binary required by the native tests. `render:check` checks Rust formatting and
TypeScript source/tools; `render:test` also checks test types and runs the native
fixtures. App native tests run serially in Moon.

`moon run render:demo` builds and launches the embedded showcase. Headless tests
do not verify physical IME, native window interaction or visible GPU presentation.
