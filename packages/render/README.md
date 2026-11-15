# Native renderer

`render` runs a Solid TypeScript UI in QuickJS and draws its native document with
Blitz and Vello/wgpu. JS and Blitz stay on the window event-loop thread; host
workers exchange owned JSON through a bounded, generation-scoped mailbox.

Tokamak uses released Blitz `0.3.0-beta.4`. Custom surface rendering and the fork
were removed on 2026-11-15 to focus on getting the app running. The work is
preserved in git on `minimal/surfaces-traversal` and `minimal/surfaces`, and in
`github.com/JustKira/blitz` on branch `tokamak`.

Nothing goes to the Blitz project without the owner's written approval.
   No pull request, issue, comment or discussion post on
   `github.com/DioxusLabs/blitz` or any related project (anyrender, vello,
   stylo, taffy, parley). Approval is per change, written by the owner on that
   change's Linear sub-issue. Reading upstream is fine.

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
  `blitz_paint::paint_scene` to draw ordinary elements. `take_error` returns deferred UI errors.
- `Error`, `Result`, `MessageSender` and `MAX_WIRE_MESSAGE_BYTES` are exported at the crate root.
- [`@tokamak/render`](js/index.ts) exports the universal JSX runtime, `mount`,
  `onHostEvent` and `observeLayout`. Events cancel synchronously; layout reports
  arrive after layout rather than through synchronous DOM measurements.

## Blitz workarounds

| Workaround | Implementation |
| --- | --- |
| Button Enter/Space activation, including repeats, focus and cancellation. | [`src/input.rs:155`](src/input.rs#L155) |
| Disabled and readonly text fields cancel editing before Blitz defaults run. | [`src/input.rs:125`](src/input.rs#L125) |
| Empty IME preedit can mean commit or cancellation; track that gap until a definitive event. | [`src/input.rs:14`](src/input.rs#L14) |
| Apple commands bypass the upstream UI event handler; route them through the DOM driver. | [`src/document.rs:163`](src/document.rs#L163) |
| Forward macOS editing bindings to Blitz. | [`src/shell.rs:284`](src/shell.rs#L284) |
| Enable the missing IME cursor-area capability. | [`src/shell.rs:334`](src/shell.rs#L334) |
| Blitz chains unused wheel deltas; overscroll-contain consumes them within the marked scroller. | [`src/input.rs:275`](src/input.rs#L275) |
| Report measurements after layout and resolve again when JS placement changes the tree. | [`src/document.rs:74`](src/document.rs#L74) |
| Blitz subtracts a scroller’s own offset from its client rect; add it back. | [`src/layout.rs:121`](src/layout.rs#L121) |
| Host mailbox wakeups must execute JS and flush mutations; requesting redraw alone does neither. | [`src/shell.rs:216`](src/shell.rs#L216) |
| Keep late Metal frames unscaled during live resize and colour the uncovered strip. | [`src/macos.rs:33`](src/macos.rs#L33) |
| AppKit offers no traffic-light position setting; place the native button container. | [`src/macos.rs:137`](src/macos.rs#L137) |
| Draw icon paths with kurbo/Vello without enabling Blitz’s full SVG parser stack. | [`src/icon.rs:12`](src/icon.rs#L12) |

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
