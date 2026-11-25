import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Addresses, Company } from "../../src/server/addresses";
import type { Fixture } from "./recorder";
import { stream, turn } from "./stream";

export type Answer =
  | { kind: "normal" | "signed-out" | "overloaded" }
  | { kind: "limit" | "partial-limit"; resetAt: number };
export type SignIn = "success" | "reject-code" | "expired" | "refuse-renewal";

function providerPath(path: string) {
  return path.replace(/^\/backend-api(?=\/)/, "");
}

export async function startFakeCompanies({ delayMs = 10 } = {}) {
  const identity = (id: string, expiresAt: number) => {
    const claims = {
      email: `${id}@example.test`,
      exp: Math.floor(expiresAt / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "plus" },
    };
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode(claims)}.synthetic`;
  };
  const accounts = new Map<
    string,
    {
      company: Company;
      id: string;
      accessToken: string;
      refreshToken: string;
      code: string;
      signIn: SignIn;
      answers: Answer[];
      expiresAt: number;
      generation: number;
    }
  >();
  const requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
    account?: string;
  }[] = [];
  let replay: Fixture["exchanges"] = [];

  function find(company: Company, value: string | undefined, key: "accessToken" | "refreshToken" | "code") {
    return [...accounts.values()].find((account) => account.company === company && account[key] === value);
  }

  async function handle(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/plugins\/agent-proxy\/[^/]+/, "");
    const route = providerPath(path.replace(/^\/(anthropic|openai)(?=\/)/, ""));
    const company: Company =
      path.startsWith("/anthropic/") || (!path.startsWith("/openai/") && route.startsWith("/v1/"))
        ? "anthropic"
        : "openai";
    const headers = Object.fromEntries(request.headers);
    const raw = await request.text();
    let body: unknown = raw || undefined;
    if (raw && headers["content-type"]?.includes("application/json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        /* Keep malformed traffic in the request log. */
      }
    } else if (headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const fields = body as Record<string, string> | undefined;
    const credential = headers.authorization?.replace(/^Bearer /i, "") ?? headers["x-api-key"];
    const renewal = fields?.grant_type === "refresh_token";
    const token = route === "/v1/oauth/token" || route === "/oauth/token";
    const authorize = route === "/oauth/authorize";
    const account = token
      ? find(company, renewal ? fields?.refresh_token : fields?.code, renewal ? "refreshToken" : "code")
      : authorize
        ? (accounts.get(url.searchParams.get("account") ?? "") ??
          [...accounts.values()].find((item) => item.company === company))
        : find(company, credential, "accessToken");
    requests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers,
      body,
      account: account?.id,
    });

    const recorded = replay[0];
    if (recorded?.request.method === request.method && providerPath(recorded.request.path) === route) {
      replay.shift();
      const { status, headers: responseHeaders, chunks } = recorded.response;
      return chunks.length
        ? stream(chunks, responseHeaders, delayMs, status)
        : new Response(null, { status, headers: responseHeaders });
    }
    if (authorize && request.method === "GET") {
      if (!account || account.company !== company) return new Response("Unknown account", { status: 400 });
      const redirect = url.searchParams.get("redirect_uri");
      // A test can inspect the callback URL without following the redirect.
      if (!redirect) return Response.json({ code: account.code, state: url.searchParams.get("state") });
      const callback = new URL(redirect);
      callback.searchParams.set("code", account.code);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      return Response.redirect(callback, 302);
    }
    if (token && request.method === "POST") {
      if (!account || (renewal ? account.signIn === "refuse-renewal" : account.signIn === "reject-code")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (renewal) {
        account.generation++;
        account.accessToken = `fake-${account.id}-access-${account.generation}`;
        account.refreshToken = `fake-${account.id}-refresh-${account.generation}`;
      }
      const expires_in = !renewal && account.signIn === "expired" ? -1 : 3600;
      account.expiresAt = Date.now() + expires_in * 1000;
      return Response.json({
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        token_type: "Bearer",
        expires_in,
        ...(company === "openai"
          ? { id_token: identity(account.id, account.expiresAt) }
          : {
              account: { uuid: account.id, email_address: `${account.id}@example.test` },
              organization: { uuid: "fake-org", name: "Fake organization" },
            }),
      });
    }
    if (route === "/api/event_logging/batch") return Response.json({});
    const isTurn =
      request.method === "POST" && ["/v1/messages", "/responses", "/codex/responses"].includes(route);
    const answer = isTurn && account && account.expiresAt > Date.now() ? account.answers.shift() : undefined;
    const error = (status: number, type: string, responseHeaders?: ResponseInit["headers"]) =>
      Response.json(
        { type: "error", error: { type, code: type, message: `Fake ${type}` } },
        { status, headers: responseHeaders },
      );
    if (!account || account.expiresAt <= Date.now() || answer?.kind === "signed-out")
      return error(401, "authentication_error");
    if (route === "/v1/messages/count_tokens") return Response.json({ input_tokens: 8 });
    if (["/models", "/codex/models", "/v1/models"].includes(route))
      return Response.json(
        company === "anthropic"
          ? {
              data: [
                {
                  id: "claude-sonnet-4-6",
                  type: "model",
                  display_name: "Fake Sonnet",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
              has_more: false,
            }
          : {
              models: [
                {
                  slug: "gpt-5",
                  display_name: "Fake GPT",
                  description: "Fixture model",
                  supported_reasoning_levels: [],
                  shell_type: "disabled",
                  visibility: "list",
                  supported_in_api: true,
                  priority: 0,
                  support_verbosity: false,
                  truncation_policy: { mode: "tokens", limit: 4096 },
                  context_window: 32768,
                  experimental_supported_tools: [],
                  use_responses_lite: false,
                },
              ],
            },
      );
    if (route === "/api/oauth/profile")
      return Response.json({
        account: { uuid: account.id, email: `${account.id}@example.test`, has_claude_pro: true },
        organization: { uuid: "fake-org", organization_type: "claude_pro" },
      });
    if (route === "/wham/usage")
      return Response.json({
        account_id: account.id,
        plan_type: "plus",
        rate_limit: { allowed: true, limit_reached: false },
      });
    if (!isTurn) return error(404, "not_found_error");
    if (answer?.kind === "overloaded") return error(company === "anthropic" ? 529 : 503, "overloaded_error");
    const responseHeaders = new Headers();
    if (answer && "resetAt" in answer) {
      responseHeaders.set(
        company === "anthropic" ? "anthropic-ratelimit-requests-reset" : "x-codex-primary-reset-at",
        company === "anthropic" ? new Date(answer.resetAt * 1000).toISOString() : String(answer.resetAt),
      );
      responseHeaders.set("retry-after", String(Math.max(0, answer.resetAt - Math.floor(Date.now() / 1000))));
    }
    if (answer?.kind === "limit")
      return error(
        429,
        company === "anthropic" ? "rate_limit_error" : "usage_limit_reached",
        responseHeaders,
      );
    responseHeaders.set("content-type", "text/event-stream");
    return stream(
      turn(company, fields?.model ?? "fake", answer?.kind === "partial-limit"),
      responseHeaders,
      delayMs,
    );
  }

  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await handle(
        new Request(new URL(incoming.url ?? "/", address), {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          body: body.length ? body : undefined,
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Fake company listener has no port");
  const address = `http://127.0.0.1:${bound.port}`;
  const addresses: Addresses = {
    anthropic: {
      api: `${address}/anthropic`,
      authorize: `${address}/anthropic/oauth/authorize`,
      token: `${address}/anthropic/v1/oauth/token`,
    },
    openai: {
      api: `${address}/openai/backend-api`,
      authorize: `${address}/openai/oauth/authorize`,
      token: `${address}/openai/oauth/token`,
    },
  };
  return {
    address,
    addresses,
    requests,
    addAccount(company: Company, id: string, signIn: SignIn = "success") {
      if (accounts.has(id)) throw new Error(`Duplicate fake account: ${id}`);
      const account = {
        company,
        id,
        signIn,
        code: `fake-${id}-code`,
        accessToken: `fake-${id}-access`,
        refreshToken: `fake-${id}-refresh`,
        generation: 0,
        expiresAt: Infinity,
        answers: [] as Answer[],
      };
      accounts.set(id, account);
      return account;
    },
    script(account: string, answers: Answer[]) {
      const target = accounts.get(account);
      if (!target) throw new Error(`Unknown fake account: ${account}`);
      target.answers = [...answers];
    },
    replay(fixture: Fixture) {
      replay = [...fixture.exchanges];
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
