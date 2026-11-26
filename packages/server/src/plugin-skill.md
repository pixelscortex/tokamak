---
name: develop-tokamak-plugin
description: Build and reload this Tokamak plugin using server actions, caller actions and window APIs.
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
  A mutation that returns `fail` rolls back its writes. A caller can handle a
  nested mutation's failure and keep its own writes, or return the failure to
  roll them back too. An action returning `fail` keeps mutations it already ran.
- **HTTP routes**: export `httpAction({ path, handler })` from the server part.
  A route such as `/:profile/*` answers under `/plugins/<id>/`. Check the caller
  in the handler; these routes do not require member sign-in. Use the web
  `Request` and return a `Response`, including a direct `fetch` response to
  stream it. The context provides `ctx.serverUrl`, `ctx.path` and `ctx.params`.
  Use `ctx.runQuery`, `ctx.runMutation`, and `ctx.runAction` with your own
  plugin's generated references. Those calls have no signed-in member.
  Read declared `env:NAME` permissions with `await ctx.env("NAME")`.
  Set `TOKAMAK_PUBLIC_URL` on the Server to read `ctx.serverUrl`. Core routes
  `/plugins/<id>/<revision>/assets/<name...>` and `/plugins/<id>/reload` take
  precedence. Handle `OPTIONS` yourself if you need CORS. Duplicate headers
  are joined and response `Set-Cookie` is dropped. Pass `request.signal` to
  outbound fetches so they can end on disconnect. Declare the usual network
  permission; each fetch from a fresh host performs its own DNS lookup and,
  for HTTPS, TLS handshake.
- **Caller actions**: use `action({ on: "caller", args, handler })` for files and programs on the
  person's computer. Use `ctx.proc([program, ...args], { cwd })` for programs
  and `ctx.signal` for cancellation. Call public server functions with their
  generated references; those calls use the same session as the window.
- **Window** (`src/client/api.tsx`): read server data using `useQuery` and
  public generated references. Use `useClient().action(ref, args)` and handle the `noMachine`
  failure when the action needs a Runner. Use `auth.me()` to read the signed-in member.
  Export a page with `view({ route: "/", title: "Editor" }, () => <Editor />)`.
  Write plain JSX. A build generates a typed `find` function on the client entry.
  A dependent plugin imports `plugin:<id>/client` and exports an action such as
  `after(owner.find("button", { in: "Editor" }), Tools)`.
  A static `data-part` or `id` supplies the element name when present. Narrow
  a name with literal `type`, `href`, `role`, or `aria` filters, such as
  `find("button", { aria: { label: "Stop" } })`. They match only static string
  attributes; `nth` counts the remaining matches. Both builds warn and ask
  for `data-part` when a search reaches a plain tag with no static name.
  The actions are `before`, `after`, `prepend`, `append`, `wrap`, `replace`, and `hide`.
  Use `{ when: (props) => … }` on an action to apply it only to matching
  component instances.
  Use `state` for window values, `derived` for computed values, and
  `keep: "device"` or `keep: "me"` when a value needs to survive a restart.
- **Contracts**: export a typed `contract<T>("name")` from `src/contracts.ts`.
  A provider declares the owner in `depends` or `optional`, imports
  `plugin:<id>/contracts`, and exports `provide(key, implementation)`. The
  owner calls `key.list(ctx)` or `key.get(id, ctx)` from an action, and leaves `ctx` out in a query or mutation. For a Runner
  contract add `{ on: "caller" }` and use caller actions for members that need a
  Runner context.
  An optional provider may copy the owner's declaration to `contracts/<id>.ts`;
  keep it byte-identical. For membership changes, use `onMember` with the
  event from `plugin:auth/contracts`.
