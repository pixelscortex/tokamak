# Agent Proxy

This plugin currently provides provider addresses and an offline test tool. The
plugin has no sign-in, proxy, tables, or window API.

`src/server/addresses.ts` is the only source of production addresses. Call
`companyAddresses()` in server code; tests can pass `fake.addresses` at the server
call site. The OpenAI API base is the ChatGPT backend root: append
`/codex/responses`, `/codex/models`, or `/wham/usage` as appropriate. QuickJS
doesn't expose the server process environment, so there is no environment
override inside the installed plugin. The explicit argument is a TypeScript
test seam; it isn't a registered plugin function or a window setting.

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
  const upstream = companyAddresses(fake.addresses).anthropic;
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
  `/plugins/agent-proxy/<profile>` prefix.
- `addAccount(company, id, signIn?)` returns a synthetic callback code and
  access and refresh tokens. Choose the account on authorize with
  `?account=<id>`. Set the returned account's `signIn` to `success`,
  `reject-code`, `expired`, or `refuse-renewal`. A successful renewal rotates
  the two tokens on that account object.
- `script(id, answers)` replaces that account's queue. A turn consumes one
  answer and defaults to `normal` when the queue is empty. The other kinds are
  `signed-out`, `overloaded`, `limit`, and `partial-limit`. Reset times are Unix
  seconds. Models and plan reads do not consume the queue.
- `requests` records the method, path and query, headers, parsed JSON or form
  (otherwise raw body), and the matched account. The in-memory log contains
  synthetic credentials; CLI test output masks credentials and session IDs.
- `replay(fixture)` queues recorded replies in order by method and provider
  path. It preserves status and cleaned headers and sends one SSE frame at a
  time. Other routes still use the scripted fake.

The CLI probes use disposable empty home and config directories, synthetic
keys, disabled optional traffic where supported, and a dead proxy for
non-loopback URLs. There is no forwarding proxy in either probe. Claude uses
`--bare -p --tools "" --model claude-sonnet-4-6 --no-session-persistence`,
`CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`. Codex uses
`exec --json --ephemeral --skip-git-repo-check --sandbox read-only`, `CODEX_HOME`,
`OPENAI_API_KEY` and a temporary `config.toml` with a custom Responses provider
(`base_url`, `env_key = "OPENAI_API_KEY"`, `wire_api = "responses"`) and
`model = "gpt-5"`. Both use an isolated `HOME`. These probes use API key mode;
they don't exercise subscription mode.

## Record a fixture as the account owner

The recorder lives under `tests/fake-companies`; it is never installed.
In a private throwaway script, create a `createRecorder()` instance. Run the
provider's normal browser consent flow yourself. Use `recorder.fetch` in place
of fetch for the callback-code exchange (and any renewal or plan reads you
want to cover), then make one streamed turn against the real API address with
the login you just received. Use a generic prompt and consume the full stream.
Supply secrets in memory using your own secure input; don't put them in the
script, shell history, or a command line. The recorder does not follow
redirects or capture the browser's sign-in pages.

```ts
const recorder = createRecorder();
// The owner's HTTP client uses recorder.fetch for the exchange and the turn.
await recorder.save("/private/new-fixture.json", {
  "Other private value returned by this provider": "[fixture value]",
});
```

`save` writes a new JSON file only after each response has finished. Rows
contain request method, path, headers and body, followed by response status,
headers and chunks. The cleaner replaces known credential, identity and
message fields, drops cookies and other unused headers, and rewrites redirect
locations to a synthetic callback. It omits HTML and other unstructured
bodies. Review the entire file before adding it to the repo: if an upstream
puts private values in new fields or embeds them in strings, extend the cleaner
or supply replacements and run it again. No real exchange has been recorded
here. The test uses a hand-made token response and SSE exchange to check the
saved file and replay.

## Shape sources

- Anthropic: CLIProxyAPI's
  [`internal/auth/claude/anthropic_auth.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/claude/anthropic_auth.go)
  gives the authorize, exchange, renewal and profile endpoints and fields.
  [`claude_executor_request.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_executor_request.go)
  gives the Bearer and `anthropic-beta: oauth-2025-04-20` subscription request
  shape. The fake records those headers without requiring the beta header.
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

**Unconfirmed until recorded:** live subscription authorize redirects and
error bodies; real token, renewal and identity payloads; subscription model
and plan/profile payloads; subscription request headers and turn envelopes;
and the real limit/reset, midstream failure, sign-out and overload responses.
These are test scenarios, with synthetic values where the wire details are
unconfirmed. The two CLI probes establish the API key request paths and that
the fake's normal SSE responses complete a text turn.
