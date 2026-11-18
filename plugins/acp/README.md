# ACP chat backend

Build with `proto run bun -- packages/build/src/build.ts plugins/acp` after chat.
`bun run app` builds both; the host loads chat first using `depends: {chat:"*"}`.

## ACP backend

Threads store a provider backend with plugin, agent ID, settings and optional session
state. `threads:setBackend` preserves state when the agent and settings match.
This plugin uses `runtime: "worker"` and requires [Bun](https://bun.sh).
Its TypeScript client uses the official `@agentclientprotocol/sdk` 2.7.0
(`ClientApp.connect` and `ndJsonStream`). `backend:describe` refreshes discovery.

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

Automated plugin tests use a fake adapter and need no credentials:

```sh
bun test plugins/acp/tests
cargo test -p server --test actions chat_acp_backend
cargo test -p server --test workers
```

Real full-stack smoke tests reuse the installed adapters and CLI logins. They
create an isolated working directory, refuse permission requests, and require a
text response through chat, the worker, ACP, and chat's storage:

```sh
cargo test -p server --test workers real_claude -- --ignored --exact --nocapture
cargo test -p server --test workers real_codex -- --ignored --exact --nocapture
```

## Package layout

`plugin.ts` declares static metadata, the `chat` dependency ID, and the existing
`runtime: "worker"` opt-in. The loader still requires `version`; dependencies compile to
`"*"` internally. The build infers this server-only package without a Vite config.

`src/server/api.ts` exports the public backend actions. Implementation lives in
`agents/`, `turn/`, and `events/`, with generated references in `_generated/`.
Chat types and host-call references use `plugin:chat/server`. ACP keeps pending
text, timers and permission deadlines in its own `turn/` helpers; chat owns all
persisted state. Every write includes the turn token, and no chat implementation
is bundled into ACP. ACP has no client half.
The compiler derives `chat.backend` from chat's public backend contract and ACP's
public functions. Callable IDs and behavior are unchanged.

## Machine link

`src/machine/main.ts` exports `start(ctx: MachineContext)`. The compiler emits
`machine.js`, its source map, and an independent protocol entry under
`entries.machine`. This is a separate supervised Bun process. It has no action
invocation or one-hour action deadline. The server restarts an exited service
with 250 ms–30 s backoff, signals cancellation on shutdown/reload, then terminates
its process group and descendants after the existing cleanup grace period.

Desktop startup replaces the local server's desired hubs through authenticated,
local-only `POST /machine/hubs` with `[{url, token}]`. An empty array stops serving
all hubs. Repeating the same configuration creates no extra links. Tokens stay
in memory; only the stable machine ID is written by the host. Browser builds do
not call this operation. Windows returns an unavailable-worker error until its
worker process containment is implemented.

Each link authenticates to its hub as its owner, registers discovered agents and
renews a 15 s lease every 3 s. Chat addresses each run to one live owner machine;
a preferred machine ID must match. Claims are atomic and never replayed. Output
writes have a contiguous sequence so retrying an append cannot duplicate text.
Permissions still use chat mutations, with answers restricted to the run owner;
any member can cancel. A lost lease interrupts the run on the hub's timer even
when no window is open.

The same ACP turn helpers receive either the local chat port or an SDK-backed
hub port. Session IDs and folders are saved only in the machine service's
`sessions.json` (mode 0600), keyed by hub origin, thread, owner and agent. This
slice starts hub sessions in the owner's home folder; it does not expose a remote
folder picker. Restorable sessions are reused. Every prompt includes the owner,
machine, thread participants and the scope of the owner's tools.

Run the sealed two-server test with
`proto run bun -- e2e/machine-link.ts`. It uses only the scripted ACP agent from
`e2e/chat-sandbox.ts`. The native stage runs it through `e2e/run.ts`; the browser
suite also exercises a chat-only hub backed by the disposable local machine.
