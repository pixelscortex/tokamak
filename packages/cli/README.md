# Tokamak CLI

Run from a checkout with the pinned Bun:

```sh
proto run bun -- run tokamak --help
proto run bun -- run tokamak plugin build /path/to/my-plugin --json
proto run bun -- run tokamak plugin add /path/to/my-plugin
proto run bun -- run tokamak plugin list --json
proto run bun -- run tokamak plugin remove my-plugin
```

`build` runs the artifact build once, defaults to the current folder, and
doesn't need a server. `add` reads the plugin's static identity from `plugin.ts`
(or the build's `package.json` convention), and doesn't build it. `add` and
`remove` only edit the index; the local server picks up membership changes on
its next start.

The app data folder contains `plugin-index.json`, a JSON object mapping each
plugin id to its absolute source folder, for example:

```json
{ "my-plugin": "/path/to/my-plugin" }
```

At startup the local server loads each indexed folder's `dist` artifact in
addition to its `--plugins` folder. A built indexed plugin wins when both
sources contain the same id. A missing index is empty; missing source folders
and entries without a build are logged and skipped.

`list` asks the running local server for its catalog. The CLI discovers it through
`server.json` and authenticates with `server.token` in the app data folder. Set
`TOKAMAK_SERVER_DIR` to use a different app data folder, including for tests.
For a server at a specific address, set `TOKAMAK_SERVER` and `TOKAMAK_TOKEN`,
or supply `--server <address>` with `TOKAMAK_TOKEN`. The flag takes precedence.
The CLI never starts a server.

With `--json`, stdout contains one JSON value and human text goes to stderr.
Without it, human text goes to stdout. Exit status is zero on success and
nonzero on failure. The CLI never prompts. Success has `ok: true` and:

| Command         | Additional result fields                            |
| --------------- | --------------------------------------------------- |
| `plugin build`  | `id`, `outputFolder`                                |
| `plugin add`    | `id`, `folder`, `restartRequired: true`             |
| `plugin remove` | `id`, `restartRequired: true`                       |
| `plugin list`   | `plugins`: an array of `{ id, version, fromIndex }` |
| `--help`        | `help`                                              |

Failures return `{ ok: false, error: { message, next } }`. Build failures with
TypeScript locations also return `error.diagnostics`, an array of
`{ file, line, column, code, message }`.

To add a command, create a file under `src/commands/` that satisfies `Command`,
then register it in `src/commands.ts`. The entry point handles flags, help,
output and exit codes. The CLI test walks the registry to check that contract.

A command that needs its own flags declares them in `flags`, for example
`flags: { errors: { summary: "Show only errors." }, out: { value: "path", summary: "Where to write the file." } }`.
A flag with `value` takes one value; a flag without it is a switch; `short` adds a
one-letter form. The command receives them as `options.flags`. Help lists them, and a
flag the command did not declare is an error. `--json`, `--server` and `--help` work on
every command and are never declared.

Without `--json`, a command's text goes to stdout. With `--json`, stdout holds exactly
one JSON value and the text goes to stderr.

Run the CLI tests with the real server:

```sh
cargo build -p server --bin tokamak-server
proto run bun -- test packages/cli/tests/cli.test.mjs
```
