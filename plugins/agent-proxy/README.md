# Agent Proxy

This plugin owns a person's AI subscriptions, the provider accounts in them,
their logins and the sign-in that makes them. It knows nothing about threads.
The proxy itself (an inbound HTTP route) comes later (TKM-263); today other
plugins read and change subscriptions through its exports.

## Exports

All in `src/server/api.ts`, all plugin-only (`plugin:agent-proxy/server`): no
window calls them directly, and none returns a login. Each answers for the
calling member only, so another member of a shared server never sees or
changes someone else's subscriptions. Every id is checked to be of the right
table; a malformed id, an id of another table, or another member's gets
`fail("NotFound")` and changes nothing.

| Function             | Kind     | Arguments                                                   | Result                                                         |
| -------------------- | -------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `listSubscriptions`  | query    | none                                                        | `{ subscriptions: SubscriptionView[], signIns: SignInView[] }` |
| `startSignIn`        | action   | `{ company: "anthropic", method: "subscription", repair? }` | `SignInView` (the link to open), or `fail("NotFound")`         |
| `finishSignIn`       | action   | `{ id, pasted }`: the address the browser ended on, or code | `SubscriptionView`, or a failure with `data.message`           |
| `cancelSignIn`       | mutation | `{ id }`                                                    | `null`, or `fail("NotFound")`                                  |
| `setLabel`           | mutation | `{ id, label }`                                             | `null`, or `fail("NotFound" \| "TooLong")`                     |
| `setEnabled`         | mutation | `{ id, enabled }`                                           | `null`, or `fail("NotFound")`                                  |
| `renewLogins`        | action   | none                                                        | `{ renewed, signedOut, waiting }`                              |
| `addAccount`         | action   | `{ id }` of a subscription                                  | `SignInView` with `addTo`, or `fail("NotFound")`               |
| `signOutAccount`     | mutation | `{ id }` of an account                                      | `null`, or `fail("NotFound")`                                  |
| `checkAgain`         | action   | `{ id }` of a subscription                                  | `SubscriptionView`, or `fail("Unreachable" \| "SignedOut")`    |
| `removeSubscription` | mutation | `{ id }` of a subscription                                  | `null`, or `fail("NotFound")`                                  |

`finishSignIn` failures that keep the sign-in waiting: `Unreadable`,
`WrongSignIn`, `Refused` (Claude did not accept the code; paste again or open
the page again for a new code), `Unreachable`, `OtherAccount` (a repair signed
in as another account), `OtherPlan` and `OtherCompany` (an added account on
another plan or of another company) and `Busy` (another finish of it is running). Ones that
end it: `AlreadyAdded`, `Gone`, `Expired`, `Cancelled`, `NotFound`.

## Several accounts, signing out, checking again, removing

A subscription can hold several provider accounts of one company, such as two
logins of one team plan (`src/server/manage.ts`). `addAccount` starts the same
sign-in with a target subscription (`addTo`); `finishSignIn` then adds the
account to it. It is refused (`AlreadyAdded`, the sign-in ends) when the
account is already signed in under this subscription or is under another of
the member's subscriptions, and (`OtherPlan`, the sign-in keeps waiting) when
Claude reports another plan for it: the subscription is one plan, so that
account is added as a subscription of its own. When Claude does not answer the
plan read, the account is taken and the subscription keeps its plan. An
account of this subscription that was signed out is signed in again in place.
New models of the added account join the subscription's list.

`SubscriptionView.status` is `ok` while at least one account is signed in (the
proxy can still use the subscription) and `signed-out` only when every account
is; each entry of `accounts` has its own `id`, `status` and `reason`.

`signOutAccount` deletes the account's login and marks it "Signed out"; the
row stays and `startSignIn` with `repair` (or `addAccount` with the same
account) signs it in again in place. `setEnabled(false)` keeps every login and
keeps renewing them; the proxy (TKM-263) will skip a subscription that is off
and an account that is signed out when it chooses one. `checkAgain` takes a
fresh login of each signed-in account (`logins:fresh`, with its renewal rules)
and reads the plan, the email and organisation, and the models again; only
what Claude answered replaces what is stored, and when it answered nothing the
result is `Unreachable` and nothing changes. `removeSubscription` deletes the
subscription, its accounts, their logins and any sign-in waiting to repair it
or add to it, in one transaction. It knows nothing of profiles: the caller
updates its own.

## Sign-in

The server does the whole sign-in over the network, as CLIProxyAPI does
(`internal/auth/claude/anthropic_auth.go`): `startSignIn` makes a PKCE
verifier and `state`, keeps both in the `signIns` table and returns only the
link (Claude Code's client id, scopes and `http://localhost:54545/callback`
redirect, `code=true`).

Nothing listens on that redirect: the Claude Code CLI does, on its own
computer, and the server cannot. So after signing in, the browser ends on a
`localhost:54545` page that fails to load, and the person copies the whole
address from the address bar and pastes it. The page that shows `code#state`
belongs to Claude's hosted manual-code redirect, which this sign-in does not
use; which redirect to use is open for the owner. `finishSignIn` still reads
an address (state as a parameter, after the code, or in the fragment), a
`code#state`, or a bare code.

`finishSignIn` claims the sign-in row first, so a second paste while one is
being exchanged gets `Busy` and changes nothing. It exchanges the code (JSON
with `state`), reads the plan, email and organisation from
`/api/oauth/profile` and the models from `/v1/models`, and stores the login in
`logins` in the same transaction that ends the sign-in. A cancel that lands
while Claude answers wins, and nothing is stored. A sign-in nobody finishes
within 15 minutes is listed as `expired`, cannot finish, and is deleted by the
next start, cancel or finish. Server actions have no `crypto.subtle`, so
`pkce.ts` computes the S256 challenge itself.

## Renewal

`logins:fresh` (internal) is the one way to a usable login: it renews the
login when it runs out within five minutes, and the proxy will call it before
every request. Renewal is claimed on the login row, so one call at a time
sends a refresh token to Claude; a caller that loses the claim uses the stored
login while it still works, or waits a few seconds for the new one. A
renewal Claude refuses (HTTP 400 or 401 from the token endpoint) deletes the
login and turns the account "Signed out"; `startSignIn` with `repair` then
signs the same subscription in again in place. A 429 waits for its
`Retry-After`; 403, 5xx, network errors and unreadable answers wait one
minute, doubling up to 30 minutes, and the account stays signed in. A plugin's
server code has no timer that may use the network (`maintenance` is a
mutation), so `renewLogins` runs only while a screen that shows subscriptions
is open. The internal functions the proxy will call take the member as
`owner`, since a proxy request has a turn key and no member behind it.

## Tables

`subscriptions`, `accounts` (one login at the company, by its account id),
`logins` (access and refresh token, expiry, renewal claim and next try) and
`signIns` (verifier, `state`, link, an optional subscription to repair, a
finish claim). Every row has the `owner` member
id. Logins sit in ordinary tables: there is no secret store yet (TKM-292), so
whoever can read the server's database can read them. No function logs them.

## Addresses

`src/server/addresses.ts` is the only source of production addresses. Call
`await companyAddresses(ctx)` from a server action. The OpenAI API base is the
ChatGPT backend root: append `/codex/responses`, `/codex/models`, or
`/wham/usage`. An administrator can set `TOKAMAK_AGENT_PROXY_ADDRESSES` on the
server or in the installation's `.env.local`. Its JSON must have exactly two
provider keys, `anthropic` and `openai`, each with `authorize`, `token`, and
`api` HTTP(S) URLs. Unset uses defaults; malformed JSON or URLs fail the action
without exposing the value. The window cannot set the variable. Normal builds
grant fetch only to the five real provider hosts, including on redirects.

The native integration test builds a disposable copy with a test-only action
and `net:127.0.0.1`, starts a workspace server on a free port, and verifies a
server action reaches the fake using its installation `.env.local`. The
shipped artifact has neither the action nor the loopback grant. The sign-in
test (`tests/sign-in.test.ts`) installs chat, ai, basic-auth, agent-proxy and
ai-profiles on a real shared server the same way and drives the Profiles
screen's functions against the fake, once for each server build it finds
(`target/debug` and the cloud build in `target/cloud/debug`). Build the native
harness once to exercise these tests:

```sh
CARGO_BUILD_JOBS=2 cargo build --locked -p server -p tokamak-plugin-host
CARGO_BUILD_JOBS=2 cargo build --locked --no-default-features -p server -p tokamak-plugin-host --target-dir target/cloud
moon run agent-proxy:test
```

Set `TOKAMAK_TEST_SERVER_BIN` and `TOKAMAK_PLUGIN_HOST` to use other builds.
If the native binaries are absent the native test prints a skip reason.

## Write an offline test

Use the same Vitest runner as the other plugins. From this directory run
`proto run bun -- run test`; from the repository root use
`moon run agent-proxy:test`.

```ts
const fake = await startFakeCompanies({ delayMs: 10 });
try {
  const account = fake.addAccount("anthropic", "acme");
  fake.script(account.id, [
    { kind: "partial-limit", resetAt: Math.floor(Date.now() / 1000) + 60 },
    { kind: "normal" },
  ]);
  const upstream = fake.addresses.anthropic;
  const response = await fetch(upstream.api + "/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true }),
  });
  // Read the text delta, then the limit event; inspect fake.requests afterward.
  console.log(await response.text());
} finally {
  await fake.stop();
}
```

- `address` is a loopback origin on an OS assigned port; `addresses` has separate
  Anthropic and OpenAI routes. Both also accept an optional
  `/plugins/agent-proxy/<set>` prefix.
- `addAccount(company, id, { signIn, strict })` registers synthetic credentials.
  Choose the next authorize account with `fake.nextSignIn(id)`. Set the
  account's `signIn` to `success`, `reject-code`, `expired`, `refuse-renewal`,
  `unavailable` (HTTP 503 from the token endpoint) or `limited` (HTTP 429,
  `Retry-After: 120`). `tokenDelayMs` slows its token answers. Successful JSON
  renewal rotates both tokens; a strict account that sends a used refresh
  token again has its whole login revoked, as companies that rotate do.
- Strict mode is the default. Authorization checks the client ID, redirect,
  and S256 challenge; exchange checks the matching verifier, redirect, client
  ID, and Anthropic's body `state`. Codex validates `state` in the callback
  before sending its form exchange, so its token body does not contain it.
  The fake redirects to the callback with `code` and `state` in the query; a
  Claude exchange sends them as separate JSON fields. A Claude
  Bearer turn requires `anthropic-beta: oauth-2025-04-20`; a Codex turn requires
  the matching `chatgpt-account-id`. Use `{ strict: false }` for a synthetic
  API-key client that does not use subscription headers.
- `script(id, answers)` replaces that account's queue. A turn consumes one
  answer and defaults to `normal` when the queue is empty. The other kinds are
  `signed-out`, `overloaded`, `limit`, and `partial-limit`. Reset times are Unix
  seconds. For Anthropic `limit`, choose `scope: "account"` (default) or
  `"model"`. A partial limit sends the error after a text delta with no reset
  headers on the HTTP 200. `signed-out` applies to one turn; pair it with
  `account.signIn = "refuse-renewal"` to make that turn's renewal fail.
  Models, plan and roles reads do not consume the queue.
- `requests` records the method, path and query, headers, parsed JSON or form
  (otherwise raw body), and the matched account. The in-memory log contains
  synthetic credentials; CLI test output masks credentials and session IDs.
- `replay(fixture)` queues recorded replies in order by method and provider
  path. It preserves status and cleaned headers and sends one SSE frame at a
  time. Other routes still use the scripted fake.

The CLI probes use disposable homes, synthetic credentials, and a loopback
blocking proxy. It prints every attempted outbound host and never forwards.
The two API key probes use Claude's `--bare`, `ANTHROPIC_BASE_URL` and
`ANTHROPIC_API_KEY`, or `codex exec` with `OPENAI_API_KEY` and a custom
Responses provider. No proxy sits between the CLI and the fake.

## What the layer 2 tests do not show

- The [Claude plugin launch](../claude/src/server/turn.ts) has no `--bare`.
  Without it, hooks, configured MCP servers, `CLAUDE.md`, and keychain lookup
  can participate, subject to launch options and settings. A private
  `CLAUDE_CONFIG_DIR` alone does not establish keychain isolation. The probe
  keeps `--bare`; it does not determine whether `ANTHROPIC_AUTH_TOKEN` or
  `ANTHROPIC_API_KEY` takes precedence over a person's existing OAuth login.
- The [Codex plugin launch](../codex/src/server/rpc.ts) runs `codex app-server`.
  In ChatGPT-login mode Codex reads its own `auth.json`, including an ID
  token, and can renew the login itself, using
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE` when set. The built-in OpenAI provider
  retains Codex backend routes when the base URL is unset or ends in
  `/backend-api/codex` (after trimming trailing slashes). The ChatGPT probe
  uses synthetic file auth and keeps that suffix on `openai_base_url`;
  `chatgpt_base_url` ends in `/backend-api`. Workspace routing on this version
  requires HTTPS, so the probe creates a temporary loopback certificate
  trusted only by its Codex child via `CODEX_CA_CERTIFICATE`. This proves the
  prefixed account and catalog routes and an SSE turn after a WebSocket
  handshake fallback. It does not test live login, credential precedence,
  a real refresh, or a WebSocket turn.

## Record a fixture as the account owner

From the repository root, run one of:

```sh
proto run bun -- plugins/agent-proxy/tests/fake-companies/record.ts anthropic /private/claude-fixture.json
proto run bun -- plugins/agent-proxy/tests/fake-companies/record.ts openai /private/codex-fixture.json
```

Open the printed sign-in link and consent in your browser. Paste the full
address the browser ends on (for Claude, `localhost:54545/callback?…`; for
Codex, `localhost:1455/auth/callback?…`) from the address bar. The redirect
need not load a local page. The script exchanges the
callback, makes one short streamed turn, and writes only the cleaned fixture
to a new file. The login stays in memory and is never printed or written.
Use an account authorized for the requested model; set `TOKAMAK_RECORD_MODEL`
to choose a different model. This workflow has not
been run against real providers here.

The cleaner replaces credential and identity fields, creates a synthetic ID
token with a minimal allowlisted claim set, replaces private path segments
and message text, and retains rate-limit headers and error codes. Review the
entire file before committing it. If a provider introduces a new private
field, update the cleaner or supply explicit replacements through
`createRecorder().save(path, replacements)`. Tests cover cleaning and replay
with a hand-made exchange.

## Shape sources

- Anthropic: CLIProxyAPI's
  [`internal/auth/claude/anthropic_auth.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/claude/anthropic_auth.go)
  gives the authorize, exchange, renewal and profile endpoints and fields.
  [`claude_executor_request.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_executor_request.go)
  gives the Bearer and `anthropic-beta: oauth-2025-04-20` subscription request
  shape. The fake requires it for strict Bearer turns.
  [`helps/claude_ratelimit.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/helps/claude_ratelimit.go)
  distinguishes account windows from model/overage limits.
  [Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
  and [Models](https://platform.claude.com/docs/en/api/models/list) give the
  text SSE events and model list envelope.
- OpenAI: Codex 0.170.0
  [`login/src/server.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/server.rs)
  gives the authorize and token exchange;
  [`login/src/auth/manager.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/auth/manager.rs)
  gives renewal and [`login/src/token_data.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/token_data.rs)
  gives the ID token claims.
  [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/model-provider-info/src/lib.rs)
  gives the ChatGPT Codex API base;
  [`backend-client/src/client.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/backend-client/src/client.rs)
  gives the account header, and
  [`backend-client/src/client/rate_limit_resets.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/backend-client/src/client/rate_limit_resets.rs)
  gives the usage path.
  [`codex-api/src/endpoint/models.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/codex-api/src/endpoint/models.rs)
  and [`protocol/src/openai_models.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/protocol/src/openai_models.rs)
  give the model catalog shape.
  [Responses streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events)
  gives the text SSE events.

  [`codex-api/src/api_bridge.rs`](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/codex-api/src/api_bridge.rs)
  gives the 429 reset and plan fields and the 503 overload code. The app-server
  [workspace routing code](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs)
  specifies the discovery fields and HTTPS requirement.

**Unconfirmed until recorded:** the real browser consent and redirect
sequence, provider-specific OAuth rejection messages, any extra values beyond
the published plan/profile/roles fields, and the live midstream limit and
sign-out wire events. The normal turn events are exercised by the local CLIs;
the documented request headers, renewal encodings, and 429/503 discriminators
come from the public source above.
