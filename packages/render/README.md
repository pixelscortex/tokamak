# Native Solid renderer — TKM-8 / TKM-19

Native product windows now use upstream **GPU Vello/wgpu**, not CPU Vello/Softbuffer.
Both the demo and composed desktop use the same shell. Metal adapter selection
and the demo's repeated render/present path have been verified; the remaining
foreground/manual gates are listed below.

**Historical TKM-8 interaction notes (CPU backend, not GPU foreground acceptance).**
A real macOS window opened and host ticks updated its Solid document while idle.
Scoped macOS keyboard events reached Tab focus, typing and paste. The validation session
could not activate/raise its own window, so mouse interaction, real Apple Backspace,
physical IME, and native Enter/Space/controlled-clear interaction are **not verified**.
Do not mark the issue done from the offscreen image or document probes.

## Run in a normal foreground macOS terminal

From the repository root, with the pinned tools installed:

```sh
moon run render:check
moon run render:build
./target/release/demo
```

Alternatively `moon run render:demo` builds and launches the same executable.
Close only the **Tokamak TKM-8** window with its close button or Cmd+Q; Ctrl+C in
its launching terminal also ends the demo. No Bun/Node process is required at runtime.
The bundle is embedded in the executable. Bundling is a moon task, not a product CLI.

Manual gate:

1. Leave the window idle: the host counter must advance every second without input.
2. Click Increment, then Tab/Shift+Tab to it; Enter and Space must each increment once.
   Holding Space must not produce duplicate clicks. The disabled button must not activate.
3. Click/tab to the editor; type, Backspace, and Cmd+V. Its displayed value must follow
   the editor. Click Controlled clear: both the native editor and Solid text must clear.
4. Toggle readonly/disabled; no text editing may occur. Tab must still leave the field.
5. With a real IME, check preedit, candidate placement and commit, including Enter used
   to confirm composition not activating a button. This remains physically untested.
6. If capturing evidence, capture **only this window** after the owner grants permission.
   No desktop capture or permission changes are part of these tasks.

## Boundaries and API

- [`NativeDocument`](src/lib.rs) owns a Blitz document and a single
  `runtime::QuickJsContext`. QuickJS and Blitz stay on the event-loop thread;
  there is no second engine, worker-side JS handle, webview, or Node runtime.
- [`launch(shell, bundle, title, connect)`](src/shell.rs) opens a native GPU-rendered
  Vello/wgpu window. `connect` receives a cloneable `HostSender`. Move that
  sender into a Rust host worker and call `send(topic, serializable_payload)`.
  Serialization creates owned JSON before the queue crossing. Successful send means
  queued, not delivered. Drop closes the generation; stale queued events are discarded.
- `NativeDocument::generation()` / `host_event(generation, topic, Json)` support an
  embedder-owned mailbox too. Generation mismatch returns `Ok(false)` before JS runs.
  A replacement document has a different generation. Senders for dropped documents
  return an error. The built-in shell services the same bounded `HostMailbox` as
  headless embedders; a proxy wake runs JS and flushes changes, not just a redraw.
  `HostMailbox::new(&document, wake)` returns a sender and receiver; `drain(&mut document)`
  services one wake budget, and `pending()` reports queued messages. Queues permit
  at most 256 messages / 1 MiB, with a 64 KiB serialized envelope cap. Overload is an
  explicit error. Each drain processes at most 32 messages, checking an 8 ms budget
  between messages, then re-wakes remaining work and returns to the event loop.
  One callback can still consume its bounded JS deadline; 8 ms is not preemption.
- [`@tokamak/render`](js/index.ts) supplies universal compiler helpers, `mount(Component)`,
  `onHostEvent<Payload>(topic, handler)`, `NativeNode`, and native `JSX`/event types.
  Subscription cleanup follows the Solid owner. `class` is a normal scalar attribute.
  `data-*`, `aria-*` (including pressed/label/disabled/invalid/describedby), and `role`
  share generic attribute transport, not app-specific native operations.
- [`NativeEvent`](js/jsx-runtime.ts) exposes numeric document-local `target` and
  `currentTarget`, `value` for input, keyboard fields, `isComposing`, and synchronous
  `preventDefault()` / `stopPropagation()`. There are no DOM objects or measurement APIs.
  `readonly`, `disabled` and `hidden` use HTML presence semantics; ARIA/data booleans
  become literal strings, so `aria-disabled={false}` does not disable an editor.
- [`wire.rs`](src/wire.rs) decodes tagged, closed-shape commands, validates a complete
  batch against a staged topology, then applies it. Unknown handles, duplicate creates,
  text/element misuse, invalid anchors, cycles and malformed names are errors before
  Blitz mutation. Nullable attribute values and insertion anchors must be explicit.
  Detached handles remain valid until document retirement; there is no DOM GC API.
  A drain/validation failure retires the generation: its JS tree may have advanced
  past the consumed batch, so further input and host delivery are rejected until
  replacement. Ordinary handler errors with a valid applied batch do not retire it.
- Native callbacks return cancellation synchronously. Ready QuickJS promise jobs are
  bounded by time/job count and flushed before draining mutations and painting.
  Handler exceptions still flush preceding valid changes. Heap limit is 64 MiB;
  load gets 2 seconds, individual calls/checkpoints 250 ms, checkpoints at most 1024 jobs.
  No implicit timers, network, filesystem, or async host operations are installed.

Example feature-side contract:

```tsx
import { createSignal } from 'solid-js';
import { mount, onHostEvent } from '@tokamak/render';
function Counter() {
  const [count, setCount] = createSignal(0);
  onHostEvent<{ count: number }>('tick', event => setCount(event.count));
  return <button class="counter" onClick={() => setCount(n => n + 1)}>{count()}</button>;
}
mount(Counter);
```

`@tokamak/ui/elements` types Button/Input props against the exported native JSX
interfaces without importing DOM globals. The renderer has no Todo/backend knowledge.

## Upstream beta policies

- Vite builds the UI through a TypeScript configuration and the maintained Solid
  plugin, configured for **universal** rather than web/DOM generation. The plugin
  still uses Babel internally for Solid JSX; there is no custom Babel transform.
  Shared native build configuration selects `solid-js/dist/solid.js` and rejects
  SSR/DOM, HMR and development-runtime leakage. Vite composes maps back to original
  TSX. Explicit type checks cover runtime source and build tools separately because
  Vite transpiles TypeScript without checking it. Build dependencies do not ship
  inside QuickJS or the native runtime.
- Button Enter/Space activation is missing upstream. The bridge owns it once:
  nonrepeating Enter down / armed Space up, respecting disabled, cancellation,
  focus changes and composition. It never adds a second pointer click path.
- `macos_handler` forwards standard Apple bindings to Blitz. Upstream's UI driver
  bypasses event handlers for Apple commands; this adapter routes those commands
  through its public DOM-event driver so cancellation/readonly/disabled also apply.
  macOS commands can precede KeyboardInput: use `onAppleKeybinding` and its `command`
  field to cancel native editing, rather than relying on a later `onKeyDown`.
- Upstream ignores readonly and still edits an already-focused disabled editor.
  The adapter cancels edit defaults explicitly; Tab remains enabled to avoid a trap.
  Readonly still permits caret navigation, selection and copy (keyboard and Apple
  commands), unlike disabled fields. Cut/paste, insertion and deletion are refused.
  Only `input type="text"` is promised: no password masking, placeholder, form or
  full selection API. Clipboard support is explicitly enabled in `blitz-shell`.
- Composition tracks active and cleared preedit, not Winit's unreliable
  `is_composing` alone. Empty preedit is ambiguous: it can precede a commit or
  cancellation. Escape/cancelOperation and ordinary new input recover immediately;
  an ambiguous confirming Enter/Space is suppressed once, not forever. Commit,
  disable and blur also clear composition. A small public `ShellProvider` delegate enables
  the cursor-area capability missing from beta.4's shell; it forwards clipboard and
  normal shell operations. **Real IME/candidate placement is still untested.**
- Focus indication uses the TKM-6 `:focus` fallback, including pointer focus. This
  is not browser-equivalent `:focus-visible`. No renderer fork was introduced.
- Full DOM, measurements, overlays, VoiceOver/accessibility integration and mobile
  are out of scope. ARIA transport is not a VoiceOver support claim.

## Package research (2026-11-06)

Read cached Fusion binding/renderer/app/runtime for ideas, never copied. Read TKM-6's
report and upstream source through the opensrc skill/cache. Firecrawl developer
search confirmed the universal JSX/moduleName contract and active Blitz/AnyRender
upgrade work. Registry metadata verified current releases, repositories and sizes;
source inspection verified mutation, event-driver, shell wake and IME APIs.

| Package | Selected / reason | Research link / size context |
| --- | --- | --- |
| `solid-js` | 1.9.18, current, fine-grained client runtime + universal host | [npm](https://www.npmjs.com/package/solid-js), [universal docs](https://github.com/solidjs/solid/tree/main/packages/solid/universal); 1,078,147 B unpacked package, not shipped bundle size |
| `vite` | 8.3.6, TypeScript build configuration, production bundling and composed maps | [TypeScript support](https://vite.dev/guide/features.html#typescript); build only |
| `vite-plugin-solid` | 2.11.15, maintained universal Solid compiler integration; Babel is internal to the plugin | [plugin options](https://github.com/solidjs/vite-plugin-solid#optionssolid); build only |
| `blitz-dom/html/traits/shell` | 0.3.0-beta.4, current published upstream, no fork | [Blitz](https://github.com/DioxusLabs/blitz), [shell](https://docs.rs/blitz-shell/0.3.0-beta.4/blitz_shell/); dom/shell crate archives 279,453 / 39,167 B |
| `anyrender_vello` | 0.15.0; maintained upstream GPU window backend, using AnyRender 0.14.0, Vello 0.11.0, wgpu 30.0.1 and wgpu_context 0.10.0 | [AnyRender](https://github.com/DioxusLabs/anyrender), [published source](https://docs.rs/crate/anyrender_vello/0.15.0/source/src/window_renderer.rs) |
| `winit` | 0.31.0-beta.3, required exact pin by Blitz (current beta.4 cannot be substituted independently) | [crate](https://crates.io/crates/winit/0.31.0-beta.3) |
| `keyboard-types` | 0.8.0, matches the verified spike; current compatible patch is 0.8.3 | [crate](https://crates.io/crates/keyboard-types/0.8.0) |
| `futures-lite` | 2.6.1, current small local `block_on`; no new multithread executor | [crate](https://crates.io/crates/futures-lite/2.6.1); archive 46,095 B |

Serde/serde_json and QuickJS are the existing workspace choices; QuickJS is reexported
by `runtime`, not independently configured. All new native dependencies are local to
`packages/render/Cargo.toml`. Bun workspace membership lets `@tokamak/ui/elements` use
its types/renderer helpers through the real `@tokamak/render` package name.

## TKM-8 validation (historical CPU presentation)

Actually run after implementation/cleanup:

- `moon run render:check`: passes native JSX/runtime types, renderer formatting,
  `cargo check --locked --package render --all-targets --jobs 2`.
- `moon run render:build`: passes, producing the stripped release demo.
- Launched the native macOS window. Scoped key events reached Tab, typing and paste;
  these checks do not replace foreground acceptance. No interaction was sent to
  unrelated windows, and system permissions/settings were unchanged.
- Throwaway document probes (removed) verified production Solid reactivity, stale
  generation rejection, Enter/Space without repeat duplicates, disabled suppression,
  native input, explicit Apple-command deletion, readonly prevention, controlled
  editor clearing and ready Promise-job flushing. These are **not physical input proof**.
- Revision probes (removed) exercised empty-preedit Escape/Apple cancel recovery,
  one-key confirmation safety, readonly caret/selection/copy versus editing,
  recoverable handler exceptions versus fatal 4 MiB consumed-batch retirement,
  and the actual production mailbox: 25,000 sends accepted only 256 queued messages;
  one drain serviced at most 32 and re-woke the rest. Byte/event caps, closure and
  stale-generation queues were also exercised. A copied production bundler ran
  successfully under a real spaced path with an interface, generic payload type,
  and annotated TSX event parameter, using the same production build configuration.
- An offscreen production document paint check exercised Blitz/AnyRender CPU output;
  it does not prove foreground input or an idle cross-thread wake. Generated logs
  and captures stay local and are not committed.
- `screencapture -l <own-window-id>` failed; screen-recording preflight was false.
  Native activation/raise was unavailable from this session. Physical click,
  Backspace, IME, candidate placement, and full foreground native interaction
  remain the owner/manual gate above. Independent renderer and UI tests now exercise
  the real QuickJS/Blitz path, and full workspace checks, tests and builds passed
  during integration; neither replaces foreground acceptance.
- `moon run :size` measures the separate reachable headless backend, currently
  **39,542,352 B**. Use the native demo measurement below for renderer size; the
  historical 286,080-byte empty host excluded both subsystems.

### Historical CPU size

`target/release/demo`: **8,617,216 bytes** (review fixes: +16 bytes from 8,617,200), reachable native window + Blitz layout/paint
+ CPU presentation + QuickJS/runtime + embedded Solid/demo JS. The former render
placeholder had no executable, so there is **no comparable pre-change renderer
binary delta**. Do not subtract the unlinked 286,080-byte host and label the result
renderer cost. System fonts and OS libraries remain external. No embedded database,
GPU stack, capture encoder or temporary probe was included in that CPU baseline.

The renderer's native and JavaScript dependencies are configured locally in
`packages/render/`, with root Bun workspace membership and shared lockfile entries.
Full-workspace integration is a separate validation step from these renderer checks.

## TKM-19 GPU presentation

Published crate manifests/source were inspected before changing dependencies:
Blitz shell beta.4 requires AnyRender 0.14.0 and exact Winit beta.3;
AnyRender Vello 0.15.0 implements that same `WindowRenderer` trait. No Blitz,
Winit, layout, JS runtime or event-driver upgrade is needed. The dependency lock
replaces the CPU/Softbuffer backend with the upstream GPU stack, including Naga
shader compilation and platform wgpu backends. OS GPU drivers remain external.

Upstream `VelloWindowRenderer` records a Vello scene, dispatches GPU compute
(`use_cpu: false`), renders to a GPU texture, then GPU-blits/presents to the
native surface. There is no frame readback or Softbuffer presentation. No JS
`navigator.gpu` or canvas APIs are installed. CPU layout/scene preparation and
QuickJS still run on the UI thread; GPU rendering is not a latency guarantee.

Blitz retains ownership of surface creation, suspend/resume, first paint,
resize and DPI propagation. Upstream wgpu_context reconfigures/reacquires once
for Lost/Outdated surfaces and skips unavailable frames; it does not implement
automatic device-loss recovery. The shell completes upstream renderer init
before its first paint to reject CPU adapters and report the actual selected
adapter/backend. Device loss emits a restart-required diagnostic, not a claim
of recovery. Initialization/render failures retain upstream fatal error behavior;
check GPU drivers and `WGPU_BACKEND`/`WGPU_ADAPTER_NAME` when selection fails.
There is no silent CPU fallback. Upstream AutoVsync, maximum queued-frame hint
of one, and GPU completion wait are retained, not replaced by a custom scheduler.

### Opt-in presentation diagnostics

Build the demo with upstream timing output enabled:

```sh
cargo build --locked --release --package render --bin demo --features gpu-diagnostics --jobs 2
./target/release/demo
```

The `gpu-diagnostics` feature forwards only to
`anyrender_vello/log_frame_times` and is **off by default**. Upstream emits each
`vello: ... (cmd: ..., render: ..., present: ..., wait: ...)` line only after
`maybe_blit_and_present` succeeds and the device completion wait returns
successfully. Together with the adapter diagnostic, this is evidence that the
selected adapter completed the upstream render/present path, unlike the adapter
line alone, which is emitted before first paint. It is not proof that pixels were
visibly displayed, physical input was accepted, or a window closed gracefully.
The timings describe renderer CPU-side stages/waits, not input-to-photon latency.
Logging can perturb performance; do not use diagnostic builds for default-product
size or idle-performance comparisons. No timing logs are tracked.

### Implementation-phase checks (2026-11-07)

- Ran exact `moon run render:check render:build render:test`, plus
  `ui:check ui:build ui:test` and `app:test`. Existing tests passed.
  Document tests do not prove GPU presentation.
- `app:check` initially failed on the pre-existing compile-time
  `app/tests/e2e.rs` include of missing `app/dist/tests/bridge.js`.
  That test-only dependency was corrected separately by loading the fixture
  at execution time; clean `app:check` then passed without `dist/tests`.
- Launched the actual release demo and desktop: both reported
  **Apple M4 Pro (Metal, IntegratedGpu)**. Before launching desktop, inspected
  directories/dirs-sys source to verify `HOME` selection; the child-only HOME
  was a scratch directory and its actual store files were confirmed there.
  Only these own child processes were terminated; no real user store was used.
- Demo CPU time at 3/8/13 seconds was 0.19/0.22/0.23 seconds; sampled CPU
  was 0% at 8/13 seconds with its one-second host tick producer running.
  Desktop CPU time was 0.29/0.50/0.77 seconds at the same offsets.
  These short `ps` samples are not GPU utilization or input/frame latency.
- A scratch-only launcher reused the production library/demo bundle with CSS
  keyframe animation, 200 overflow rows and host events every 16 ms. It launched
  on the same Metal adapter without GPU validation errors; CPU time at 3/8/13
  seconds was 0.47/2.20/3.85 seconds. This verifies adapter initialization and
  workload execution without reported errors, not successful presentation,
  visual animation correctness, scrolling input, frame rate or latency.
- No physical input/IME, candidate placement, scrolling interaction, resize/DPI
  interaction, suspend/resume, or injected surface/device-loss acceptance was
  verified in this implementation pass. No screenshots/logs/probes are tracked.
  Final integration validation is recorded below.

### Measured native release sizes

Same isolated source baseline `bf304bc1`, aarch64 macOS / Rust 1.97.0,
workspace release profile. Measured with `moon run :size render:build` before,
and `moon run :size` plus `render:build` after; demo sizes use `stat -f %z`.

| Binary | Own CPU baseline (bytes) | GPU (bytes) | Delta (bytes) |
| --- | ---: | ---: | ---: |
| headless `tokamak` | 39,542,368 | 39,542,368 | 0 |
| `tokamak-desktop` | 46,191,600 | 49,055,088 | +2,863,488 |
| renderer `demo` | 8,633,872 | 11,563,696 | +2,929,824 |

The supplied earlier demo baseline was 8,617,216 bytes; it is **not** the locally
rebuilt baseline. The parent's later close-diagnostic fix is not in these
measurements; remeasure after integration rather than attributing that separate
change to GPU presentation. These are complete binaries, not isolated GPU
dependency archive sizes, memory measurements, or cross-platform guarantees.

### Final integration validation

Separate implementation, test-writing and fresh review passes are complete.
Review corrected the resume comment and the smoke supervisor's SIGTERM cleanup;
the final source and test delta have no remaining blocking review findings.

The integration owner ran:

- `CARGO_BUILD_JOBS=2 moon run :check :test`: **20 tasks passed**, including
  15 native renderer, 16 UI, three launch-construction failure, and 15 application
  integration cases, plus compiler/type/lifecycle and backend suites.
- `CARGO_BUILD_JOBS=2 moon run :build :size :e2e`: **16 tasks passed**, including
  release builds and all five Todo POC scenarios.
- `python3 packages/render/tests/gpu_smoke_supervision_test.py -v`: **three passed**,
  including missing-marker cleanup, uncooperative-child escalation and SIGTERM
  sent to the supervisor without leaking its owned child.
- Exact `moon run render:gpu-smoke`: **passed**, selecting Apple M4 Pro /
  Metal / IntegratedGpu and completing seven upstream render/present paths.
  Earlier one/two-frame deadline failures were not counted as passes. The final
  run retained the same thresholds and required a visible, unoccluded window.
- The default release desktop independently selected the same Metal adapter
  without frame diagnostics. Its child-only `HOME` and actual store path were
  verified isolated before/after launch. Bounded SIGTERM/reaping was used,
  not a physical window-close or graceful-backend-shutdown acceptance test.
- `git diff --check`: passed. Existing macOS debug linker unwind-table warnings
  remain; no GitHub CI result is claimed.

Final default release measurements are **39,542,368 B** for the headless server,
**49,055,088 B** for the desktop, and **11,563,696 B** for the native demo.
Against the integration owner's preceding close-fix desktop at 46,208,112 B,
the measured desktop delta is **+2,846,976 B**; the headless size is unchanged.
The earlier implementation table uses its own CPU baseline and is not substituted
for this comparison.

These checks establish hardware adapter selection and execution of the upstream
render/present path, not compositor-visible pixel correctness, physical
mouse/IME behavior, resize/DPI interaction, suspend/loss recovery, frame rate
or input-to-photon latency. Those foreground/manual gates remain open.
