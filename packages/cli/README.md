# Tokamak CLI

Run from a checkout with the pinned Bun:

```sh
proto run bun -- run --silent tokamak --help
proto run bun -- run --silent tokamak plugin build /path/to/my-plugin --json
proto run bun -- run --silent tokamak plugin add /path/to/my-plugin
proto run bun -- run --silent tokamak plugin list --json
proto run bun -- run --silent tokamak plugin remove my-plugin
```

`build` runs the artifact build once, defaults to the current folder, and
doesn't need a server. `add` reads the plugin's static identity from `plugin.ts`
(or the build's `package.json` convention), and doesn't build it. `add` and
`remove` only edit the index; the local server picks up membership changes on
its next start. Both commands serialize index updates with an exclusive owner
file: a dead owner can be removed, and a live owner is never displaced. An
update that cannot get the lock within 15 seconds fails. Indexed builds must use
`<folder>/dist`; both build and add reject a Vite configuration that changes
that location.

The app data folder contains `plugin-index.json`, a JSON object mapping each
plugin id to its absolute source folder, for example:

```json
{ "my-plugin": "/path/to/my-plugin" }
```

At startup the local server loads each indexed folder's `dist` artifact in
addition to its `--plugins` folder. A built indexed plugin wins when both
sources contain the same id; startup logs which copy it replaces. A missing
index is empty. Unreadable or malformed indexes are logged and ignored; bad
entries are logged and skipped, leaving any copy from `--plugins` available.

`list` asks the running local server for its catalog. The CLI discovers it through
`server.json` and authenticates with `server.token` in the app data folder. Set
`TOKAMAK_SERVER_DIR` to use a different app data folder, including for tests.
For a server at a specific address, set `TOKAMAK_SERVER` and `TOKAMAK_TOKEN`,
or supply `--server <address>` with `TOKAMAK_TOKEN`. The flag takes precedence.
Local discovery checks the process and compares the authenticated health
identity to the discovery file. Only `tokamak server start` starts a server.

From a checkout, build the plugins and the server executable:

```sh
proto run bun -- run tokamak plugin build plugins/chat
proto run bun -- run tokamak plugin build plugins/acp
cargo build --locked -p server --bin tokamak-server
proto run bun -- run tokamak server start
```

Build each plugin you install in the plugins folder. The CLI and desktop app
share the data folder, discovery files, and startup lock. Both reuse a running
server when its server build id and plugins folder match. If they differ, the
CLI asks you to stop the running server before starting a different one.
`TOKAMAK_PLUGIN_DIR` selects the plugins folder for both launchers.

Use `tokamak invite <name>`, `tokamak members`, and `tokamak revoke <id>` as
the owner. A local invite grants access to the local workspace as a member.
Running agents through the desktop app stays with the owner. A shared server
invite is a join link. Keep invites private. With `--json`, an invite is
printed only in the stdout JSON.

`server status` reports `running: true, responsive: false` when discovery
points to a live process that does not answer its health request.

With `--json`, stdout contains one JSON value and human text goes to stderr.
Without it, normal output goes to stdout and errors go to stderr. Exit status is zero on success and
nonzero on failure. The CLI never prompts. Success has `ok: true` and:

| Command         | Additional result fields                                        |
| --------------- | --------------------------------------------------------------- |
| `plugin build`  | `id`, `outputFolder`                                            |
| `plugin add`    | `id`, `folder`, `restartRequired: true`, `precedence: "index"`  |
| `plugin remove` | `id`, `restartRequired: true`                                   |
| `plugin list`   | `plugins`: an array of `{ id, version, fromIndex }`             |
| `invite`        | `invite`: token or join link                                    |
| `members`       | `members`: active `{ id, name, role }` entries                  |
| `revoke`        | `revoked`: member id                                            |
| `server start`  | `address`, `pid`, `buildId`, `reused`                           |
| `server status` | `running`; when true: `responsive`, `address`, `pid`, `buildId` |
| `server stop`   | `stopped`: whether a running server was stopped                 |
| `--help`        | `help`                                                          |

Failures return `{ ok: false, error: { message, next } }`. Artifact build and
configuration failures include `error.diagnostics`, an array with a full
`message` and, when available, `file` (absolute), `line`, `column`, and `code`.

To add a command, create a file under `src/commands/` that satisfies `Command`,
then register it in `src/commands.ts`. The entry point handles flags, help,
output and exit codes. The CLI test walks the registry to check that contract.

A command that needs its own flags declares them in `flags`, for example
`flags: { errors: { summary: "Show only errors." }, out: { value: "path", summary: "Where to write the file." } }`.
A flag with `value` takes one value; a flag without it is a switch; `short` adds a
one-letter form. The command receives them as `options.flags`. Help lists them, and a
flag the command did not declare is an error. `--json` and `--help` are shared.
Set `usesServer: true` to accept the shared `--server <address>` option and show
it in that command's help.

Run the CLI tests with the real server:

```sh
cargo build -p server --bin tokamak-server
proto run bun -- test packages/cli/tests
```
