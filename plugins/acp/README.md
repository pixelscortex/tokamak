# ACP chat backend

Build with `proto run bun -- packages/build/src/build.ts plugins/acp` after chat.
`bun run app` builds both; the host loads chat first using `depends: {chat:"*"}`.

## ACP backend

Threads store a provider backend with plugin, agent ID, settings and optional session
state. `threads:setBackend` preserves state when the agent and settings match.
Only this plugin declares the `acp` grant;
built-in agents permit this plugin automatically. Custom agents in `agents.toml`
must allow `plugins = ["acp"]`. `backend:describe` lists agents because ACP is action-only.

ACP opens and saves a session before prompting. Restored sessions receive only
the new user text; fresh sessions also receive the most recent flattened completed
history, capped at 32 KB.
Text uses the same ordered persistence and 100 ms buffer as other replies.
Non-text message content becomes `[image]` or `[resource]`. Tools use
`plugin:"acp:<agent>"`, retain ACP call IDs and follow the existing size limits.
Plans use `{type:"plan", entries:[{content, status, priority}]}`; each update
replaces the message's single plan part. Other updates, including thoughts, are ignored.

Normal completion and token/turn limits finish successfully (limits append a
short note); refusals persist `Agent refused`. Cancellation stops the agent and
settles running tools with `error:"cancelled"`. Authentication errors while
opening suggest signing in to the agent in a terminal. Permission requests flush text and persist an inline `permission` part with the request
and call IDs, title, options, and `pending`, `answered`, `expired`, or `cancelled`
status. The run sets `waiting` while polling for an answer; heartbeats continue.
The first valid option wins.
Answers record `optionId`. The generic storage mutations are exported by chat.
After 30 minutes the request expires and ACP receives cancelled; stopping a run
cancels its pending permission, and stale recovery expires it.

Map groups waiting threads under NEEDS YOU above RUNNING. Permission options appear
inline with allow options first. With an empty composer, 1–4 answers the latest
pending request. Answered rows show the chosen option dimmed; expired and cancelled
rows show their status.

## Configuring real agents

Install the pinned adapters globally once:

```sh
npm install -g @agentclientprotocol/claude-agent-acp@0.106.0 @agentclientprotocol/codex-acp@2.6.0
```

Tokamak discovers Claude Code, Codex, and Gemini CLI (`gemini --acp`) automatically
on PATH and in common global install directories (see the [README](../../README.md)).
Discovery refreshes each time agents are listed. Sign in with `claude` or `codex`
in a terminal first; adapters reuse existing CLI logins through HOME.
Only named environment variables pass through: `PATH`, `HOME`, `USER`, and `LANG`
when present. The executable's directory is prepended to PATH for its helpers.
Agents have the same access as their CLI; the selected folder is not a sandbox.

[`agents.example.toml`](../../agents.example.toml) documents optional overrides,
`enabled = false`, and custom agents. Store `agents.toml` in `$TOKAMAK_SERVER_DIR`,
or the default Tokamak data directory described in the README. Alternatively,
`TOKAMAK_ACP_AGENTS` selects a config file directly. Entries override built-ins by ID;
omitted fields retain built-in defaults. Custom agents must allow `plugins = ["acp"]`.
Restart the server after config edits. API keys are optional: add their names to
`env` and set them in the server environment or repository-root `.env.local`.

Manual credentialed checks (ignored by the normal suite) discover the installed
adapters with no config required. `TOKAMAK_ACP_AGENTS` is an optional override.
Each test uses a temporary copy of this repo's tracked files and refuses
permission requests.

```sh
cargo test -p server --test acp acp_real_claude_smoke -- --ignored --exact --nocapture
cargo test -p server --test acp acp_real_codex_smoke -- --ignored --exact --nocapture
```
