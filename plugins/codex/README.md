# Codex

Install this plugin alongside `chat` and `ai` to pick Codex in a chat thread.
It runs the official `codex app-server` on the sender's computer, with the
sender's own CLI settings and login. It needs **Codex CLI 0.170.0 or newer**.
Install with `npm install -g @openai/codex`, sign in with `codex login`, and
make the `codex` executable available on the client's PATH. The client also
forwards `CODEX_HOME` when set; the CLI otherwise uses its normal home and
credential store.

The adapter speaks the [Codex app-server protocol](https://developers.openai.com/codex/app-server/).
It offers the model and effort catalog and the Default and Plan collaboration
modes. When the model catalog advertises service tiers, it also offers
Standard and the catalog's tier IDs in the separate Speed picker (`priority`
is Fast). The selection applies only to that turn. A turn starts in its
selected folder, reopens its Codex session when
available, and feeds prior chat text to a fresh session. Full access uses
Codex's full sandbox access with approvals off. Ask first uses the
workspace-write sandbox with the `untrusted` approval policy: safe reads run,
and the sender approves every other command and edit, which then lands. Codex's structured
tasks and proposed plan are separate reports. The interactive
`item/tool/requestUserInput` request is not supported yet.

`CARGO_BUILD_JOBS=2 cargo test --locked -p server --test codex_turns` runs
the real server, build, and local worker against recorded exchanges in
[e2e/fake-agent/replays/codex](../../e2e/fake-agent/replays/codex). The files
exclude personal data and shorten consecutive deltas. `history.jsonl` also
exercises protocol shapes for tasks and multi-file edits. `helpers.jsonl`
comes from a real `multi_agent_v2` run. The replay driver scans the tapes for
private data; run just the scan with
`proto run bun -- e2e/fake-agent/replay-privacy.mjs codex`.

To verify with an installed, signed-in Codex, run locally:

```sh
CARGO_BUILD_JOBS=2 cargo build --locked -p server --bin tokamak-server
proto run bun -- plugins/codex/tests/e2e.mjs target/debug/tokamak-server --real
```

The second command makes paid turns against the local Codex login. The work
folders and approval test files are disposable. The script rejects
`--real` under CI. The Rust test never passes that flag.
