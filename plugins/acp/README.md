# ACP chat backend

Build with `proto run bun -- packages/build/src/build.ts plugins/acp` after chat.
`bun run app` builds both; the host loads chat first using `depends: {chat:"*"}`.

## ACP backend

Threads store a provider backend with plugin, agent ID, settings and optional session
state. `threads:setBackend` preserves state when the agent and settings match.
Only this plugin declares the `acp` grant;
configure permitted agents in the host data directory's `agents.toml` with
`plugins = ["acp"]`. `backend:describe` lists agents because ACP is action-only.

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

Copy [`agents.example.toml`](../../agents.example.toml) to `agents.toml` in the
Tokamak data directory: `$TOKAMAK_SERVER_DIR` when set, otherwise
`~/Library/Application Support/com.pixelscortex.Tokamak` on macOS
(`$XDG_DATA_HOME/tokamak` or `~/.local/share/tokamak` on Linux).
Agents are loaded once at startup; restart the app (server) after editing `agents.toml`.
Install the pinned adapters globally once:

```sh
npm install -g @agentclientprotocol/claude-agent-acp@0.106.0 @agentclientprotocol/codex-acp@2.6.0
```

The example runs `claude-agent-acp` and `codex-acp` directly, avoiding downloads
that can exceed the 30-second initialization timeout. Only named `env` variables
are passed through: `PATH`, `HOME`, and `USER` by default. `HOME` lets adapters
reuse existing Claude Code and Codex logins in `~/.claude` and `~/.codex`.
API keys are optional: list `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `env` only
if you prefer keys, and set them in the server environment or repository-root
`.env.local`.
Agents have the same access as their CLI; the selected folder is not a sandbox.

Manual credentialed checks (never part of the normal suite): set
`TOKAMAK_ACP_AGENTS` to the absolute path of a real `agents.toml` with the relevant
`claude` / `codex` entry allowing `acp`. Each test uses a temporary copy of this
repo's tracked files and refuses permission requests.

```sh
TOKAMAK_ACP_AGENTS=/absolute/path/agents.toml cargo test -p server --test acp acp_real_claude_smoke -- --ignored --exact --nocapture
TOKAMAK_ACP_AGENTS=/absolute/path/agents.toml cargo test -p server --test acp acp_real_codex_smoke -- --ignored --exact --nocapture
```
