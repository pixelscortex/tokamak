# Tokamak artifact build

Build a plugin's server artifact from the repository root:

```sh
proto run bun -- packages/build/src/build.ts plugins/chat
```

The builder reads literal `plugin.ts` metadata, bundles `src/server/` through the
SDK compiler, derives public function references and provider contracts, and
writes a versioned `dist/manifest.json` with hashes of final emitted bytes.
Worker plugins also receive their Bun action bundle and worker entry.
Unchanged output preserves bytes and modification times. The manifest is
published last; installation still needs its own complete-artifact staging.

`PLUGIN_UI_BUILD_ENABLED` in `src/vite.ts` disables the plugin UI target.
Manifests omit `entries.ui` and client contributions while it is disabled.
Client source is not checked, transformed, or bundled. Enabling the switch
requires implementing the web target; it currently throws explicitly.
There is no native JSX compiler or CommonJS registration output.
The server target and optional `backend: false` / `ui: false` options retain
their names. A package with no enabled target cannot produce an installable plugin.

`src/contributions.ts` and `src/client-surface.ts` retain static contribution
inference and compiler-qualified slot/component identities for the next target.
Focused tests exercise those contracts independently of UI bundling.
`src/css.ts` retains Tailwind compilation. The app uses Vite directly.
The old lab declaration-check failure disappeared with the lab and native
Vite plugin; no declaration workaround remains.
