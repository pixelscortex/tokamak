# Todo plugin

Build independently with `bun run plugin:build plugins/todo`. The artifact in
`dist/` contains a namespaced backend and an external UI module. Installing this
project under the launcher's `plugins/` directory adds its `Todo` view to the rail.
`Todos` is also an ordinary public component export.

`src/todos.tsx` uses the shell's connected SDK client. It never mounts a document
or opens a connection. The two live panels exercise the same saved task list.

The old raw-bundle tests copy these sources into `app/dist/tests/todo` and supply
`app/tests/fixtures/todo-main.tsx` as a standalone host. `_legacyApi.ts` exists
only for that compatibility build; the installed UI uses `_generated/api.ts`.
