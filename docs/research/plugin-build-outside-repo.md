# Building a Tokamak plugin outside the repository

TKM-148 · Tested at `85e9d0b` on macOS 26.5.1 (arm64), with Bun 1.4.4, Vite 8.3.6, and Cargo 1.97.0. I used a tracked-source copy of the checkout under `/tmp` for builds and separate scratch folders for external plugins, artifacts, and server data.

## Summary

- The build tool accepts an absolute external plugin folder. A plain copy of Chat fails. With a dependency link and two TypeScript path fixes, it builds without changes to its source or to the build tool.
- On this Mac, passing `/tmp/…` produced a false import-boundary violation on an extensionless generated import. Passing the canonical `/private/tmp/…` path avoided it.
- Chat's `workspace:*` dependencies cannot be installed from the copied package alone. Backend types, bundled client dependencies, and CSS imports still need to resolve from the plugin.
- A new query and a plain JSX component built with an empty `package.json` and a link to the checkout's SDK. To register a routed view, I also needed a small local TypeScript config. Moon and Vite config files were unnecessary.
- Cross-plugin builds look for sibling source folders by plugin ID. An installed runtime artifact does not supply the public source entry that the builder looks up.
- The headless server loaded both external artifacts. A backend-only rebuild took effect on the same WebSocket after CLI reload. Both plugins got new UI and CSS URLs, with identical asset bytes. I did not test a window.

## Build timings

Each run used `/usr/bin/time -p proto run bun -- packages/build/src/build.ts plugins/chat` from the scratch checkout. I installed dependencies first. I removed `plugins/chat/dist`, `plugins/chat/src/server/dist`, and `plugins/chat/src/server/_generated` before each clean run. The three rebuilds kept all output and used unchanged inputs. These are wall-clock times with dependencies and tool caches already warm.

| Build | Run 1 | Run 2 | Run 3 | Median | Publisher output on each run |
| --- | ---: | ---: | ---: | ---: | --- |
| Clean | 1.60 s | 1.60 s | 1.61 s | 1.60 s | 7 changed, 0 unchanged |
| Rebuild | 1.62 s | 1.59 s | 1.68 s | 1.62 s | 0 changed, 7 unchanged |

The rebuild still runs the backend check and bundle and the Vite build. The final publisher skips writes when bytes match (`packages/build/src/build.ts:24–37,49–71`).

## What breaks outside the repo

Run the build from the scratch checkout root. In these commands, `R=/private/tmp/tkm-outside.gE2t7n`. Paths and diagnostics below are from the run; repeated stack frames and follow-on type errors are omitted.

| Command / change | Observed error | Cause and smallest fix tested |
| --- | --- | --- |
| `proto run bun -- packages/build/src/build.ts /tmp/tkm-outside.gE2t7n/chat` | `Error: Plugin import boundary: /tmp/tkm-outside.gE2t7n/chat/src/server/threads/threads.ts imports "../_generated/api" (/tmp/tkm-outside.gE2t7n/chat/src/server/_generated/api) outside its plugin folder.` The full diagnostic is in the log below. | The scan runs before generation. The root and existing importer are realpathed; an extensionless unresolved target is only passed through `resolve()`. macOS spells the existing directory `/private/tmp`. The two spellings fail containment. Use the physical path (`cd "$dir" && pwd -P`). See `packages/build/src/vite.ts:73–75` and `packages/sdk/tools/plugin-boundary.mjs:18–22,79–88,244–257`. |
| `proto run bun -- packages/build/src/build.ts "$R/chat"` | `error TS5083: Cannot read file '/private/tmp/tsconfig.json'.` Also `error TS2307: Cannot find module '@tokamak/sdk' or its corresponding type declarations.`, then `Feature type check failed (only ES2022 globals are allowed)` and `SDK backend bundling failed`. | Chat's backend `extends` goes four levels up. The type checker resolves SDK imports from plugin and generated files. Link the installed Chat `node_modules` and point the scratch server config's `extends` at the checkout's `tsconfig.json`. The link by itself removed all errors except TS5083. See `plugins/chat/src/server/tsconfig.json:2–4`, `packages/sdk/tools/bundle.mjs:69–75,187–221`, and `packages/build/src/vite.ts:97–112`. |
| `(cd "$R/chat-install-only" && proto run bun -- install --frozen-lockfile)`; also tried without `--frozen-lockfile` | `error: Workspace dependency "@tokamak/build" not found`; same for `@tokamak/runtime`, `@tokamak/sdk`, and `@tokamak/ui`. Bun reports `Searched in "./*"`. | The lone copied `package.json` still has `workspace:*` references. The checkout's root workspace is what connects those packages. Reusing the installed plugin dependencies worked; copying the manifest did not. See `package.json:4–12` and `plugins/chat/package.json:9–25`. |
| External Chat build after linking dependencies and fixing **only** the backend config | `Tsconfig not found /private/tmp/app/tsconfig.json` from `builtin:vite-transform`. | The client config extends the app config four levels up; Chat's top-level config extends that client config. Point the scratch client config at the checkout's `app/tsconfig.json`. With both config fixes and the dependency link the build reported `Plugin artifact: 7 changed, 0 unchanged`. See `plugins/chat/src/client/tsconfig.json:2`, `plugins/chat/tsconfig.json:2`, and `app/tsconfig.json:3–13`. |
| `proto run bun -- packages/build/src/build.ts "$R/selective/chat"` with fixed configs and only SDK and `marked` linked, then with Tailwind added | `Error: Can't resolve 'tailwindcss/utilities.css' in '/private/tmp/tkm-outside.gE2t7n/selective/chat/src/client'`; then `Error: Can't resolve '@tokamak/ui/theme.css' in '/private/tmp/tkm-outside.gE2t7n/selective/chat/src/client'`. | Tailwind resolves stylesheet imports from the CSS file's directory. Link `tailwindcss` and `@tokamak/ui` too. These four links were enough for this Chat build. See `plugins/chat/src/client/styles.css:1–4`, `packages/build/src/ui-build-config.ts:31–43`, and `packages/build/src/css.ts:7–24`. |
| `proto run bun -- packages/build/src/build.ts "$R/minimal"` with just the descriptor, query, and plain JSX component | `Error: ENOENT: no such file or directory, open '/private/tmp/tkm-outside.gE2t7n/minimal/package.json'`. | `package.json` is read unconditionally, even with complete metadata in `plugin.ts`. An empty JSON object is enough. See `packages/build/src/vite.ts:73–82`. |
| Same minimal build, with `package.json` set to `{}` | `probe.ts(1,23): error TS2307: Cannot find module '@tokamak/sdk' or its corresponding type declarations.` Two generated files reported the same missing module. | Bun's backend **bundling** alias for the SDK does not apply to the earlier **type check**. A single `node_modules/@tokamak/sdk` link to `$R/checkout/packages/sdk` fixed it. No local config was needed for the plain component; the backend check fell back to the checkout config. See `packages/sdk/tools/bundle.mjs:91–94,122–128,187–221`. |
| Same minimal build with the component exported through the SDK's `view({ route: "/outside-probe" }, …)` helper | Exit 0 and `ui.js` emitted, but `plugin.contributes` was `{}`. | View registration inspects the SDK contribution brand with TypeScript. Its client metadata program does not inherit the backend check's fallback configuration. A local root `tsconfig.json` with `module: "ESNext"`, `moduleResolution: "Bundler"`, `jsx: "preserve"`, and `jsxImportSource: "@solidjs/web"` produced `{"view":[{"id":"OutsideView","route":"/outside-probe"}]}`. See `packages/build/src/contributions.ts:20–53,60–69` and `packages/build/src/artifact-bundle.ts:39–49`. |
| Same minimal build after adding optional `src/client/styles.css` with the Tailwind utilities import | `Error: Can't resolve 'tailwindcss/utilities.css' in '/private/tmp/tkm-outside.gE2t7n/minimal/src/client'`. | A local Tailwind link fixed the import. Referencing the Tokamak theme also needs the local UI package link. No stylesheet is required for the query or the view declaration. |
| `proto run bun -- packages/build/src/build.ts "$R/isolated/acp"` (extra check, no sibling Chat) | `Plugin import plugin:chat/server: missing public API /private/tmp/tkm-outside.gE2t7n/isolated/chat/api.ts`, appended to the import-boundary diagnostic. | This is a lookup failure for a sanctioned import. The builder looks beside ACP for Chat source. Copying ACP beside the external Chat source got past that lookup and exposed ACP's missing Node types and inherited backend config instead. I did not build or run external ACP to completion. See `plugins/acp/src/server/relay.ts:13` and `packages/sdk/tools/plugin-boundary.mjs:91–107,233–239`. |

### Path and layout assumptions in the code

- **Entry and tools.** `packages/build/src/build.ts:16–28,31–34` resolves the folder from the caller's cwd (or accepts an absolute path). It detects a local `vite.config.ts`, if present; that config then supplies the build plugin. Without one, the CLI installs Tokamak's Vite plugin itself. `packages/build/src/vite.ts:40–64` and `descriptor.ts:9–23` derive the root and conventional entry files (`plugin.ts`, `src/server`, and `src/client/api.ts`, `api.tsx`, or `main.tsx`, with legacy fallbacks). Those conventions are relative to the plugin, not the repo. `packages/sdk/tools/server-files.mjs:3–22` recognizes `src/server` and excludes support files from query discovery. The builder itself is tied to the checkout: it reaches across to `../../sdk/tools/` in `packages/build/src/vite.ts:8,97–109`, `plugin-boundary.ts:3`, `descriptor.ts:1–3`, `exports.ts:1–2`, `client-surface.ts:1`, and `contributions.ts:1`. The backend subprocess inherits cwd and invokes `proto` from PATH. `.prototools:2–4` supplies the checkout pins. Outside the checkout, the same `proto run bun -- --version` selected 1.4.5 on this machine. `packages/sdk/tools/bundle.mjs:20,150–166,192–200` resolves relative backend CLI paths from the workspace, uses a checkout TS config as fallback, and changes cwd to the backend for generation. Absolute backend paths work. Worker generation reads the SDK source and worker entry directly from that same SDK tree (`packages/sdk/tools/worker.mjs:54–65,87–91`).
- **Package and type resolution.** `package.json:4–12` enrolls `plugins/*` and the local packages as workspaces. Chat and ACP depend on those private source packages (`plugins/chat/package.json:9–25`, `plugins/acp/package.json:7–12`, `packages/build/package.json:2–18`, `packages/sdk/package.json:2–13`, `packages/ui/package.json:2–12`, `packages/runtime/package.json:2–14`). A built backend is self-contained, but its input and generated source still need the SDK. The public artifact's `api.ts` is source-relative, not a standalone declaration bundle (`packages/sdk/tools/bundle.mjs:24–39,69–75`; `packages/build/src/vite.ts:116–134`). The backend check, static import scan, public function export check, provider derivation, UI export scan, and contribution scan read TypeScript configs from different starting points: `bundle.mjs:187–221`, `plugin-boundary.mjs:39–63,141–143,230–244`, `packages/build/src/exports.ts:15–29`, `descriptor.ts:126–140`, `client-surface.ts:19–27`, and `contributions.ts:20–36`. ACP also inherits the repo config and requests `node` types (`plugins/acp/src/server/tsconfig.json:2–9`; `worker.mjs:7–14`; `bundle.mjs:205–208`).
- **Boundary and sibling source.** The boundary checks type imports and scans unused source files. It rejects relative escapes, escaping source symlinks, raw `@plugins/*` imports, and imports that resolve into another plugin, even if linked as a package. It allows SDK source under this SDK checkout and normal installed packages. The repo root is not a required ancestor. The canonical path mismatch above is an edge case of rules built around real paths. See `packages/sdk/tools/plugin-boundary.mjs:18–37,73–88,226–318,338–359` and `packages/build/src/plugin-boundary.ts:9–31`. Both `plugin:<id>/server` and `plugin:<id>/client` first look for a sibling folder literally named `<id>` and its public API source. The checker materializes types under `.tokamak/types` and points TS path aliases there (`plugin-boundary.mjs:23–24,46–63,91–107,193–223`). Provider inference does another sibling lookup for `../<id>/src/server/api.ts` and silently skips it if absent (`descriptor.ts:126–140`). ACP's `plugin:chat/server` and declared dependency use that setup (`plugins/acp/src/server/relay.ts:13`, `plugins/acp/plugin.ts:2–12`). The runtime can resolve built plugins by manifest ID; that does not remove the build's source lookup.
- **Solid and Tailwind.** Vite uses Solid and treats shared JS imports as host modules: Solid, SDK, UI, `@tokamak/runtime/router`, UI SDK, and compiled `@plugins/*` references (`packages/build/src/vite.ts:164–169`; `ui-build-config.ts:7–26`). Other JS imports such as Chat's `marked` resolve and bundle from the plugin. Tailwind scans from the stylesheet directory by default and adds explicit sources. Chat uses `@source "./"`; the linked Tokamak theme adds its own source directory. Moving the plugin does not require a repo-relative Tailwind glob. In a separate external copy, the class `p-[37px]` in the TSX view produced `padding:37px` in `dist/styles.css`. Import resolution still needs the local packages, and the plugin assumes the shell supplies base styles and theme tokens (`packages/build/src/css.ts:7–24`, `plugins/chat/src/client/styles.css:1–4`, `packages/ui/src/theme.css:1–14`, `app/src/styles.css:1–4`).
- **Product build and desktop launch.** `.moon/workspace.yml:5–16` registers checkout projects, including Chat. `moon.yml:44–53` and `app/moon.yml:22–31` use fixed built-in paths. Chat's own `moon.yml:1–8` defines a test task; the public builder does not read it. `app/scripts/prepare-host.ts:5–15,21–38` builds Chat and ACP from the repo and stages artifacts discovered under repo `plugins/`; `app/src-tauri/tauri.conf.json:42` maps them to bundle resources. The alternate dev server script copies repo Chat and has a `TOKAMAK_PLUGIN_DIR` override (`app/scripts/server.ts:5–23`). The Docker image separately builds and copies repo Chat (`Dockerfile:16–22,29–37`). The desktop runtime honors `TOKAMAK_PLUGIN_DIR` first. Debug defaults to the checkout's `../../plugins`; release defaults to resources `plugins`. It canonicalizes the result and passes it as `--plugins`. Reuse checks that same canonical root and the binary build ID (`app/src-tauri/src/server.rs:125–137,373–389,424–431`).
- **Server catalog, data, and assets.** No repo ancestry check. The supplied path can be an artifact itself or a parent of immediate plugin folders; each candidate can hold `manifest.json` directly or in `dist/`. Hidden children are skipped. A child with `package.json` but no built manifest is an error; a source-only child without `package.json` is skipped. Duplicate IDs fail. The root is saved for reload (`packages/server/src/main.rs:185–195,232–236,343–351`; `plugins/catalog.rs:23–70,155–163`; `service/startup.rs:80–89,108–119`). There is one layout dependency: dotenv fallback is `.env.local` beside the supplied plugins root (in its **parent**), after process env; moving that root also moves the lookup (`plugins/catalog.rs:91`, `environment.rs:5–16,28–39`). Worker data uses the database directory where available and the installation root's parent as fallback (`service/startup.rs:85–89`, `plugins/catalog.rs:8–15`, `plugins/loading.rs:202–203`). The artifact verifier canonicalizes the artifact directory, checks its hashes, snapshots files, and rejects an individual asset that resolves outside it. It serves manifest-listed UI files rather than source or backend files. A symlink for the whole artifact directory worked in the runtime test (`plugins/artifact.rs:12–30,74–84`; `plugins/assets.rs:112–153,186–195,212–229`; `websocket.rs:402–441`; these paths are under `packages/server/src/`).
- **Window.** No local plugin path is needed in the window. `app/src/plugins/adapter.ts:10–15,19–47,53–76` builds same-origin URLs from catalog data and forwards change events from the configured source. `web-host.ts:72–99,113–150` (same directory) fetches JS and CSS and resolves plugin UI imports through the catalog. The shell builds its host import map from repo package manifests and app dependencies (`app/src/plugins/vite.ts:9–29,73–98`). External UI must match that host module contract. The runtime retires affected generations and updates the catalog on change (`packages/runtime/js/plugins.ts:72–99,149–170`).

## What a new plugin needs today

| Today | What it should need |
| --- | --- |
| Static `plugin.ts` with `definePlugin({ id, version, … })`, conventional server and client source, and an extra `package.json` (even `{}`). | Descriptor and source. A package manifest makes sense when the plugin brings its own dependencies. |
| A way to resolve the matching SDK from plugin source. The scratch link worked. The direct CLI still needs the installed checkout and its pinned toolchain. | A versioned SDK and build entry that can be installed without the checkout. |
| No TS config for the tested query and plain JSX component. A local TS config made the SDK's routed view show up in the manifest. Copying Chat also requires repairing both inherited configs. | Built-in compiler defaults for both halves; optional local config for overrides. |
| No `moon.yml`, `vite.config.ts`, local lockfile, schema, or authored server `api.ts` for this query and view. The tool generated `_generated/api.ts`. Tailwind dependencies were only needed when I added a stylesheet. Authored `src/server/api.ts` is for exposing functions to other plugins; it was not needed to call the query as a client. | Keep those files optional. Resolve styles with the build tool's defaults, and resolve other plugins' public contracts from explicit dependencies instead of sibling source paths. |

The final backend exported `ping = query({ handler: async () => "outside-v1" })` from `src/server/probe.ts`. The client exported a routed `OutsideView` from `src/client/api.tsx`. I changed only the query's return string for the reload check.

## Reload on a running server

I ran `cargo build -p server --bin tokamak` in the scratch checkout. It finished in 1m 03s. I copied Chat's `dist` into the scratch installation and linked the minimal plugin's whole `dist` directory there so the next build would publish into the same installation.

```sh
R=/private/tmp/tkm-outside.gE2t7n
BIN="$R/checkout/target/debug/tokamak"
"$BIN" --plugins "$R/runtime/plugins" --data "$R/runtime/data" \
  --local-dir "$R/runtime/local" --listen 127.0.0.1:0
# From the scratch checkout, after editing probe.ts:
proto run bun -- packages/build/src/build.ts "$R/minimal"
TOKAMAK_SERVER_DIR="$R/runtime/local" "$BIN" plugin reload outside-probe
```

The server picked `127.0.0.1:49598`. I used a private scratch `server.token` and scratch discovery. `--local-dir` enables the CLI's authenticated reload route, and it takes precedence over `--data`: the effective data path was `$R/runtime/local/store` (`packages/server/src/main.rs:45–68,75–138,323–328`; `packages/server/src/websocket.rs:182–185`).

| Check | Observed |
| --- | --- |
| HTTP `GET /plugins` and assets at startup | Catalog contained `chat` and `outside-probe`. Both JS and both CSS requests were HTTP 200 and matched the manifest hashes. |
| WebSocket query `outside-probe/probe:ping` | `"outside-v1"` before the edit, and still `"outside-v1"` after the successful rebuild but before reload. |
| CLI reload | Exited 0. Existing WebSocket received `pluginchanged` with `plugins: ["outside-probe"]` and the new catalog revision. The next query returned `"outside-v2"`. PID stayed 49449. |
| Asset URLs and bytes after reload | Catalog revision changed from `42834fef0ad7941125a49b67a3b9e7697a554c01dbc33d4ec12404d2703b79f4` to `aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5`. Both plugins' JS and CSS URLs changed. New URLs returned HTTP 200 with the same SHA-256 digests as before. All four old URLs returned HTTP 404. |

Reload rereads the configured root and swaps in a verified catalog rather than building source (`packages/server/src/service/plugin_control.rs:89–109,130–167`). The builder includes asset hashes in the manifest (`packages/build/src/artifact-bundle.ts:51–64`). The server derives one catalog revision from the manifests and puts it into all asset URLs, including URLs for unchanged plugins (`packages/server/src/plugins/catalog.rs:70–78,103–111`). That explains the observed URL change on a backend-only edit. The server rejects stale revisions (`packages/server/src/service/plugin_control.rs:59–75`).

I verified delivery of the reload event and the bytes at the new URLs. I did not verify a webview remount, an actual browser fetch after invalidation, or rendering of the contributed view. The probe was an HTTP/WebSocket client without a window or DOM. I did not launch the installed desktop app or use its Application Support folder.

<details>
<summary>Raw command log</summary>

Commands are grouped by experiment. Output retains the original diagnostic text; repetitive stack frames and cascading TypeScript errors are omitted.

```text
$ git rev-parse --short HEAD
85e9d0b
$ mktemp -d /tmp/tkm-outside.XXXXXX
/tmp/tkm-outside.gE2t7n
$ mkdir -p /tmp/tkm-outside.gE2t7n/{checkout,logs}
$ git archive HEAD | tar -x -C /tmp/tkm-outside.gE2t7n/checkout
$ cp -R plugins/chat /tmp/tkm-outside.gE2t7n/chat
$ R=/private/tmp/tkm-outside.gE2t7n
$ cd "$R/checkout"
$ proto run bun -- install --frozen-lockfile
bun install v1.4.4 (38afee6c8)

+ @playwright/test@1.65.1
+ @types/json-schema@7.0.15
+ @types/node@26.6.6
+ jscpd@5.4.3
+ oxfmt@0.78.0
+ oxlint@1.93.0
+ vite@8.3.6

446 packages installed [965.00ms]
```

```text
$ for run in 1 2 3; do
    rm -rf plugins/chat/dist plugins/chat/src/server/dist plugins/chat/src/server/_generated
    /usr/bin/time -p proto run bun -- packages/build/src/build.ts plugins/chat
  done
$ for run in 1 2 3; do
    /usr/bin/time -p proto run bun -- packages/build/src/build.ts plugins/chat
  done
clean 1
Plugin artifact: 7 changed, 0 unchanged
real 1.60
clean 2
Plugin artifact: 7 changed, 0 unchanged
real 1.60
clean 3
Plugin artifact: 7 changed, 0 unchanged
real 1.61
rebuild 1
Plugin artifact: 0 changed, 7 unchanged
real 1.62
rebuild 2
Plugin artifact: 0 changed, 7 unchanged
real 1.59
rebuild 3
Plugin artifact: 0 changed, 7 unchanged
real 1.68
```

```text
$ proto run bun -- packages/build/src/build.ts /tmp/tkm-outside.gE2t7n/chat
vite v8.3.6 building client environment for production...
✓ 0 modules transformed.
✗ Build failed in 56ms
error: Build failed with 1 error:
Error: Plugin import boundary: /tmp/tkm-outside.gE2t7n/chat/src/server/threads/threads.ts imports "../_generated/api" (/tmp/tkm-outside.gE2t7n/chat/src/server/_generated/api) outside its plugin folder. Keep helpers inside this plugin or install a package through node_modules. Use "plugin:<id>/server" for public types and host-call references, or "plugin:<id>/client" for the client registry.
```

```text
$ proto run bun -- packages/build/src/build.ts "$R/chat"
vite v8.3.6 building client environment for production...
error TS5083: Cannot read file '/private/tmp/tsconfig.json'.
_generated/api.ts(2,47): error TS2307: Cannot find module '@tokamak/sdk' or its corresponding type declarations.
_generated/build-bSTXC9/entry.ts(2,115): error TS2307: Cannot find module '@tokamak/sdk' or its corresponding type declarations.
Found 154 errors in 21 files, checked 21 files [6.48ms]
error: Feature type check failed (only ES2022 globals are allowed)
✓ 0 modules transformed.
✗ Build failed in 261ms
error: Build failed with 1 error:
Error: SDK backend bundling failed
```

```text
$ ln -s "$R/checkout/plugins/chat/node_modules" "$R/chat/node_modules"
$ proto run bun -- packages/build/src/build.ts "$R/chat"
vite v8.3.6 building client environment for production...
error TS5083: Cannot read file '/private/tmp/tsconfig.json'.
Found 1 error, checked 36 files [15.10ms]
error: Feature type check failed (only ES2022 globals are allowed)
✓ 0 modules transformed.
✗ Build failed in 273ms
error: Build failed with 1 error:
Error: SDK backend bundling failed
```

```text
$ mkdir -p "$R/chat-install-only"
$ cp plugins/chat/package.json "$R/chat-install-only"
$ (cd "$R/chat-install-only" && proto run bun -- install --frozen-lockfile)
$ (cd "$R/chat-install-only" && proto run bun -- install)
# Both reported the following resolution errors:
bun install v1.4.5 (a7733435c)
error: Workspace dependency "@tokamak/build" not found
Searched in "./*"
error: Workspace dependency "@tokamak/runtime" not found
Searched in "./*"
error: Workspace dependency "@tokamak/sdk" not found
Searched in "./*"
error: Workspace dependency "@tokamak/ui" not found
Searched in "./*"
error: @tokamak/build@workspace:* failed to resolve
error: @tokamak/runtime@workspace:* failed to resolve
error: @tokamak/sdk@workspace:* failed to resolve
error: @tokamak/ui@workspace:* failed to resolve
```

```text
# With only the server extends fixed to $R/checkout/tsconfig.json:
$ proto run bun -- packages/build/src/build.ts "$R/chat"
vite v8.3.6 building client environment for production...
✓ No type errors in 36 files [15.27ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 1 modules transformed.
✗ Build failed in 772ms
error: Build failed with 1 error:
    Tsconfig not found /private/tmp/app/tsconfig.json
```

```text
# With client extends also fixed to $R/checkout/app/tsconfig.json:
$ proto run bun -- packages/build/src/build.ts "$R/chat"
vite v8.3.6 building client environment for production...
✓ No type errors in 36 files [16.85ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 31 modules transformed.
✓ built in 1.45s
Plugin artifact: 7 changed, 0 unchanged
```

```text
# In a separate Chat copy, with both configs fixed and only SDK and marked linked:
$ proto run bun -- packages/build/src/build.ts "$R/selective/chat"
Error: Can't resolve 'tailwindcss/utilities.css' in '/private/tmp/tkm-outside.gE2t7n/selective/chat/src/client'
$ ln -s "$R/checkout/plugins/chat/node_modules/tailwindcss" "$R/selective/chat/node_modules/tailwindcss"
$ proto run bun -- packages/build/src/build.ts "$R/selective/chat"
Error: Can't resolve '@tokamak/ui/theme.css' in '/private/tmp/tkm-outside.gE2t7n/selective/chat/src/client'
$ ln -s "$R/checkout/packages/ui" "$R/selective/chat/node_modules/@tokamak/ui"
$ proto run bun -- packages/build/src/build.ts "$R/selective/chat"
vite v8.3.6 building client environment for production...
✓ No type errors in 36 files [14.92ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 31 modules transformed.
✓ built in 1.34s
Plugin artifact: 7 changed, 0 unchanged
```

```text
# With plugin.ts, src/server/probe.ts, and src/client/api.tsx in minimal:
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
Error: ENOENT: no such file or directory, open '/private/tmp/tkm-outside.gE2t7n/minimal/package.json'
$ printf '{}\n' > "$R/minimal/package.json"
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
vite v8.3.6 building client environment for production...
_generated/api.ts(2,47): error TS2307: Cannot find module '@tokamak/sdk' or its corresponding type declarations.
_generated/build-V6YIXr/entry.ts(2,115): error TS2307: Cannot find module '@tokamak/sdk' or its corresponding type declarations.
probe.ts(1,23): error TS2307: Cannot find module '@tokamak/sdk' or its corresponding type declarations.
Found 3 errors in 3 files, checked 60 files [6.49ms]
error: Feature type check failed (only ES2022 globals are allowed)
✓ 0 modules transformed.
✗ Build failed in 148ms
error: Build failed with 1 error:
Error: SDK backend bundling failed
$ mkdir -p "$R/minimal/node_modules/@tokamak"
$ ln -s "$R/checkout/packages/sdk" "$R/minimal/node_modules/@tokamak/sdk"
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
vite v8.3.6 building client environment for production...
✓ No type errors in 75 files [7.71ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 2 modules transformed.
✓ built in 531ms
Plugin artifact: 6 changed, 0 unchanged
```

```text
# After replacing the plain component with the SDK view helper:
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
vite v8.3.6 building client environment for production...
✓ No type errors in 75 files [7.26ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 2 modules transformed.
✓ built in 478ms
Plugin artifact: 3 changed, 3 unchanged
$ jq '.plugin.contributes' "$R/minimal/dist/manifest.json"
{}
# After adding styles.css:
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
Error: Can't resolve 'tailwindcss/utilities.css' in '/private/tmp/tkm-outside.gE2t7n/minimal/src/client'
$ ln -s "$R/checkout/plugins/chat/node_modules/tailwindcss" "$R/minimal/node_modules/tailwindcss"
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
vite v8.3.6 building client environment for production...
✓ No type errors in 75 files [7.04ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 3 modules transformed.
✓ built in 480ms
Plugin artifact: 2 changed, 5 unchanged
# After adding the minimal root tsconfig.json described above:
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
vite v8.3.6 building client environment for production...
✓ No type errors in 75 files [6.79ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 3 modules transformed.
✓ built in 596ms
Plugin artifact: 1 changed, 6 unchanged
$ jq -c '.plugin.contributes' "$R/minimal/dist/manifest.json"
{"view":[{"id":"OutsideView","route":"/outside-probe"}]}
$ ln -s "$R/checkout/packages/ui" "$R/minimal/node_modules/@tokamak/ui"
$ cp plugins/chat/src/client/styles.css "$R/minimal/src/client/styles.css"
$ proto run bun -- packages/build/src/build.ts "$R/minimal"
vite v8.3.6 building client environment for production...
✓ No type errors in 75 files [7.33ms]
 -> dist/bundle.js + source map, _generated/api.ts
✓ 3 modules transformed.
✓ built in 635ms
Plugin artifact: 2 changed, 5 unchanged
```

```text
$ cp -R plugins/acp "$R/acp"
$ proto run bun -- packages/build/src/build.ts "$R/acp"
error TS2688: Cannot find type definition file for 'node'.
error TS5083: Cannot read file '/private/tmp/tsconfig.json'.
$ mkdir -p "$R/isolated"
$ cp -R plugins/acp "$R/isolated/acp"
$ proto run bun -- packages/build/src/build.ts "$R/isolated/acp"
Error: Plugin import boundary: /private/tmp/tkm-outside.gE2t7n/isolated/acp/src/server/relay.ts imports "plugin:chat/server" outside its plugin folder. Keep helpers inside this plugin or install a package through node_modules. Use "plugin:<id>/server" for public types and host-call references, or "plugin:<id>/client" for the client registry. Plugin import plugin:chat/server: missing public API /private/tmp/tkm-outside.gE2t7n/isolated/chat/api.ts
$ (cd "$R" && proto run bun -- --version)
1.4.5
$ proto run bun -- --version
1.4.4
# In the external scan copy, after replacing font-bold in the view with p-[37px]:
$ proto run bun -- packages/build/src/build.ts "$R/scan"
Plugin artifact: 7 changed, 0 unchanged
$ rg -o 'padding:37px' "$R/scan/dist/styles.css"
padding:37px
```

```text
$ cargo build -p server --bin tokamak
Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 03s
$ mkdir -p "$R/runtime"/{plugins/chat,plugins/outside-probe,local,data}
$ cp -R "$R/chat/dist" "$R/runtime/plugins/chat/dist"
$ ln -s "$R/minimal/dist" "$R/runtime/plugins/outside-probe/dist"
$ (umask 077; openssl rand -hex 32 | tr -d '\n' > "$R/runtime/local/server.token")
$ "$R/checkout/target/debug/tokamak" --plugins "$R/runtime/plugins" --data "$R/runtime/data" --local-dir "$R/runtime/local" --listen 127.0.0.1:0
Auto-granted 0 declared capabilities to chat@0.3.0 (trusted local plugins)
Auto-granted 0 declared capabilities to outside-probe@0.1.0 (trusted local plugins)
Tokamak listening on ws://127.0.0.1:49598/ws (local capability, no TLS)
$ proto run bun -- "$R/probe.ts"
before catalog 42834fef0ad7941125a49b67a3b9e7697a554c01dbc33d4ec12404d2703b79f4 chat,outside-probe
GET /plugins/chat/42834fef0ad7941125a49b67a3b9e7697a554c01dbc33d4ec12404d2703b79f4/assets/ui.js 200 2f48bd8bb464684be6278a7cbff89e712e6331c231e6c4772b5aadd80012f7bf private, max-age=31536000, immutable
GET /plugins/chat/42834fef0ad7941125a49b67a3b9e7697a554c01dbc33d4ec12404d2703b79f4/assets/styles.css 200 b2eca66ad0f584ab809e63bf5d7f4c9c77b6e427cae53d589d9808ee425790e9 private, max-age=31536000, immutable
GET /plugins/outside-probe/42834fef0ad7941125a49b67a3b9e7697a554c01dbc33d4ec12404d2703b79f4/assets/ui.js 200 f7aa302affa54ddd9c1f5a671950f82913acf0798dd65eca4d11f063331381a9 private, max-age=31536000, immutable
GET /plugins/outside-probe/42834fef0ad7941125a49b67a3b9e7697a554c01dbc33d4ec12404d2703b79f4/assets/styles.css 200 e3e1f5ef098d8de51ccc89cb964466ddb43d5c5c1afb55a47f3542648a3da388 private, max-age=31536000, immutable
WS {"type":"response","id":1,"result":{"Ok":"outside-v1"}}
$ proto run bun -- packages/build/src/build.ts /private/tmp/tkm-outside.gE2t7n/minimal
vite v8.3.6 building client environment for production...
 -> dist/bundle.js + source map, _generated/api.ts
transforming...
✓ 3 modules transformed.
rendering chunks...
✓ built in 624ms
Plugin artifact: 3 changed, 4 unchanged
WS {"type":"response","id":2,"result":{"Ok":"outside-v1"}}
$ /private/tmp/tkm-outside.gE2t7n/checkout/target/debug/tokamak plugin reload outside-probe
CLI reload revision aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5
WS {"type":"pluginchanged","plugins":["outside-probe"],"catalog":{"paged":true,"revision":"aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5"}}
WS {"type":"response","id":3,"result":{"Ok":"outside-v2"}}
after catalog aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5 chat,outside-probe
GET /plugins/chat/aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5/assets/ui.js 200 2f48bd8bb464684be6278a7cbff89e712e6331c231e6c4772b5aadd80012f7bf private, max-age=31536000, immutable
GET /plugins/chat/aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5/assets/styles.css 200 b2eca66ad0f584ab809e63bf5d7f4c9c77b6e427cae53d589d9808ee425790e9 private, max-age=31536000, immutable
GET /plugins/outside-probe/aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5/assets/ui.js 200 f7aa302affa54ddd9c1f5a671950f82913acf0798dd65eca4d11f063331381a9 private, max-age=31536000, immutable
GET /plugins/outside-probe/aad19051de0d91c604e5314643c8a0ee33c4edbdb60fe9345c953f5561d292b5/assets/styles.css 200 e3e1f5ef098d8de51ccc89cb964466ddb43d5c5c1afb55a47f3542648a3da388 private, max-age=31536000, immutable
GET old chat/ui.js 404
GET old chat/styles.css 404
GET old outside-probe/ui.js 404
GET old outside-probe/styles.css 404
same server PID 49449 49449
```

The probe opened one WebSocket with the scratch capability. It sent `{"type":"query","id":1,"name":"outside-probe/probe:ping","args":{}}` and repeated that request with IDs 2 and 3. It used the same capability for HTTP requests, ran the CLI with `TOKAMAK_SERVER_DIR="$R/runtime/local"`, and closed the socket. The shell stopped the scratch server when the probe finished.

</details>
