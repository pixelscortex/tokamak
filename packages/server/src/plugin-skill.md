---
name: develop-tokamak-plugin
description: Build and reload this Tokamak plugin using the server, local and window APIs.
---

Use the Tokamak checkout and install its dependencies with `proto run bun -- install`.
From the checkout root, build this folder with
`proto run bun -- packages/build/src/build.ts plugins/<id>`. Commit the
generated references in `src/server/_generated/` and component declarations in
`src/client/_generated/`. Reload the installed build with
`tokamak-server plugin reload <id>`, then check the behavior on the local server.

- **Server** (`src/server`): use `query` to read, `mutation` to write in one
  transaction, and `action` for effects. Define table schemas with
  `defineSchema` and `defineTable`; validate arguments with `v`. Read the caller
  from `ctx.auth.user` and `ctx.auth.device`, and check authorization before a
  write. Use `internalQuery`, `internalMutation`, or `internalAction` for
  operations private to this plugin. Use the generated `internal` references
  with `ctx.runQuery`, `ctx.runMutation`, or `ctx.runAction`. Return
  `fail(kind, data)` for expected failures and check them with `isFailure`.
- **Local part**: use `local({ args, handler })` for files and programs on the
  person's computer. Use `ctx.proc([program, ...args], { cwd })` for programs
  and `ctx.signal` for cancellation. Call public server functions with their
  generated references; those calls use the same session as the window.
- **Window** (`src/client/api.tsx`): read server data using `useQuery` and
  public generated references. Use `useClient().local(ref, args)` when the
  client has a local part, and `auth.me()` to read the signed-in member.
  Export a page with `view({ route: "/", title: "Editor" }, () => <Editor />)`.
  Use `component("editor", {}, () => <section part="tools">…</section>)` to
  expose an element from a reusable component. Mark an element `locked` to
  forbid actions on it. A dependent plugin imports `plugin:<id>/client` and
  exports an action such as `after(owner.Editor.tools, Tools)`. The actions
  are `before`, `after`, `prepend`, `append`, `wrap`, `replace`, and `hide`.
  Use `{ when: (props) => … }` on an action to apply it only to matching
  component instances.
  Use `state` for window values, `derived` for computed values, and
  `keep: "device"` or `keep: "me"` when a value needs to survive a restart.
- **Contracts**: export a typed `contract<T>("name")` from `src/contracts.ts`.
  A provider declares the owner in `depends` or `optional`, imports
  `plugin:<id>/contracts`, and exports `provide(key, implementation)`. The
  owner calls `key.list()` or `key.get(id)`. For a local contract add
  `{ place: "local" }` and use `local` for members that need a local context.
  An optional provider may copy the owner's declaration to `contracts/<id>.ts`;
  keep it byte-identical. For membership changes, use `onMember` with the
  event from `plugin:auth/contracts`.
