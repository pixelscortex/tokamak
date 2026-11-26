import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, type FunctionReference, type TokamakClient } from "@tokamak/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockingProxy, cliEnvironment, empty, run } from "./cli-sandbox";
import { startFakeCompanies } from "./fake-companies";
import { turn } from "./fake-companies/stream";
import { builds, startWorkspace, type Workspace } from "./workspace";

type Ref<K extends "action" | "mutation" | "query", A, R> = FunctionReference<K, A, R>;
type Set = { set: string };
type Key = { key: string };
type Address = Key & { address: string };
type Id = { id: string };
type Subscription = Id & { accounts: Id[]; lastUsedAt?: number };
type Failure = { failed: true; kind: string };
const api = createApi<{
  turns: {
    register: Ref<"mutation", { set?: string; subscriptions: string[] }, Set | Failure>;
    key: Ref<"action", Set, Address | Failure>;
    end: Ref<"mutation", Key, null>;
  };
}>("turn-caller", ["turns:register", "turns:key", "turns:end"]);
const profiles = createApi<{
  subscriptions: {
    startSignIn: Ref<"action", { company: "anthropic"; method: "subscription" }, Id & { link: string }>;
    finishSignIn: Ref<"action", Id & { pasted: string }, Subscription>;
    setEnabled: Ref<"mutation", Id & { enabled: boolean }, null>;
    list: Ref<"query", Record<string, never>, { subscriptions: Subscription[] }>;
  };
  manage: { signOut: Ref<"mutation", Id, null> };
}>("ai-profiles", [
  "subscriptions:startSignIn",
  "subscriptions:finishSignIn",
  "subscriptions:setEnabled",
  "subscriptions:list",
  "manage:signOut",
]);

const model = "claude-sonnet-4-6";
const body = `{ "model": "${model}",\n  "stream": true, "messages": [{"role":"user","content":"héllo"}] }\n`;
const stream = (address: Address, path = "/v1/messages", apiKey = false, signal?: AbortSignal) =>
  fetch(address.address + path, {
    method: "POST",
    body,
    signal,
    headers: {
      [apiKey ? "x-api-key" : "authorization"]: apiKey ? address.key : `Bearer ${address.key}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
      "x-test-header": "unchanged",
    },
  });
const rejected = async (response: Response, status: number, message: string) => {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { message } });
};

const available = builds();
if (!available.length) console.log("Skipping: build both server binaries and plugin hosts to test the proxy");

describe.skipIf(!available.length).each(available)("Claude proxy on the $name", (build) => {
  let fake: Awaited<ReturnType<typeof startFakeCompanies>>;
  let workspace: Workspace;
  let client: TokamakClient;
  const secrets: string[] = [];

  beforeAll(async () => {
    fake = await startFakeCompanies({ delayMs: 70 });
    workspace = await startWorkspace(build, fake.addresses, { turnCaller: true });
    client = await workspace.owner();
  }, 300_000);

  afterAll(async () => {
    const output = workspace?.output() ?? "";
    await workspace?.stop();
    await fake?.stop();
    for (const secret of secrets) expect(output.includes(secret)).toBe(false);
  });

  async function signIn(id: string, expired = false, as = client) {
    const account = fake.addAccount("anthropic", id, { signIn: expired ? "expired" : "success" });
    secrets.push(account.accessToken, account.refreshToken);
    const start = await as.action(profiles.subscriptions.startSignIn, {
      company: "anthropic",
      method: "subscription",
    });
    fake.nextSignIn(id);
    const page = await fetch(start.link, { redirect: "manual" });
    const subscription = await as.action(profiles.subscriptions.finishSignIn, {
      id: start.id,
      pasted: page.headers.get("location")!,
    });
    expect(subscription.id).toBeDefined();
    return { account, subscription };
  }

  async function register(subscriptions: string[]) {
    const result = await client.mutation(api.turns.register, { subscriptions });
    if ("failed" in result) throw new Error(result.kind);
    return result;
  }

  async function key(set: Set) {
    const result = await client.action(api.turns.key, set);
    if ("failed" in result) throw new Error(result.kind);
    secrets.push(result.key);
    return result;
  }

  const messages = () => fake.requests.filter(({ path }) => path.startsWith("/anthropic/v1/messages"));

  test("fills the first account, swaps credentials, preserves the request and streams unchanged bytes", async () => {
    const { account, subscription } = await signIn("first");
    const second = (await signIn("second")).subscription;
    const set = await register([subscription.id, second.id]);
    const address = await key(set);
    expect(address.address).toMatch(/\/plugins\/agent-proxy\/[^/]+$/);
    const path = "/v1/messages?beta=true&label=a%20b&label=%2B";
    const response = await stream(address, path, true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const decoder = new TextDecoder();
    const initial = decoder.decode(first.value, { stream: true });
    expect(first.done).toBe(false);
    expect(initial).toContain("event: message_start");
    expect(initial).not.toContain("event: message_stop");
    let result = initial;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    expect(result + decoder.decode()).toBe(turn("anthropic", model, false).join(""));
    const request = messages().at(-1)!;
    expect(request).toMatchObject({
      method: "POST",
      path: "/anthropic" + path,
      rawBody: body,
      account: account.id,
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-test-header": "unchanged",
      },
    });
    expect(request.headers).not.toHaveProperty("x-api-key");
    expect(JSON.stringify(request)).not.toContain(address.key);
    const updated = await client.query(profiles.subscriptions.list, {});
    expect(updated.subscriptions.find(({ id }) => id === subscription.id)?.lastUsedAt).toBeGreaterThan(0);
    expect(updated.subscriptions.find(({ id }) => id === second.id)?.lastUsedAt).toBeUndefined();

    await expect(
      client.mutation(api.turns.register, { ...set, subscriptions: [second.id, subscription.id] }),
    ).resolves.toEqual(set);
    const reordered = await stream(address);
    expect(reordered.status).toBe(200);
    await reordered.text();
    expect(messages().at(-1)?.account).toBe("second");

    // Forward the encoded path as received instead of reconstructing it from decoded params.
    const encoded = await fetch(address.address + "/v1/%6Dodels?limit=1", {
      headers: { "x-api-key": address.key },
    });
    await encoded.text();
    expect(fake.requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/anthropic/v1/%6Dodels?limit=1",
      account: "second",
    });
  });

  test("scopes sets and key issuance and revocation to their member; rejects other-set, ended and unknown keys", async () => {
    const { subscription } = await signIn("private");
    const member = await workspace.member("proxy-member");
    const other = await signIn("member-private", false, member);
    const a = await register([subscription.id]);
    const b = await register([]);
    const first = await key(a);
    const next = await key(a);
    const elsewhere = await key(b);
    expect(first.key).not.toBe(next.key);
    expect(first.address).toBe(next.address);

    await expect(member.action(api.turns.key, a)).resolves.toMatchObject({ failed: true, kind: "NotFound" });
    await expect(member.mutation(api.turns.register, { ...a, subscriptions: [] })).resolves.toMatchObject({
      failed: true,
      kind: "NotFound",
    });
    await expect(
      client.mutation(api.turns.register, { subscriptions: [other.subscription.id] }),
    ).resolves.toMatchObject({ failed: true, kind: "NotFound" });
    await expect(
      member.mutation(api.turns.register, { subscriptions: [subscription.id] }),
    ).resolves.toMatchObject({ failed: true, kind: "NotFound" });
    await member.mutation(api.turns.end, { key: next.key });

    const count = messages().length;
    await rejected(await fetch(first.address + "/v1/messages"), 401, "Missing or invalid turn key.");
    await rejected(
      await stream({ ...elsewhere, key: first.key }),
      401,
      "Turn key belongs to a different set.",
    );
    await rejected(await stream({ ...first, key: "x".repeat(43) }), 401, "Unknown turn key.");
    await client.mutation(api.turns.end, { key: first.key });
    await rejected(await stream(first), 401, "Turn key has ended.");
    expect(messages()).toHaveLength(count);
    const response = await stream(next);
    expect(response.status).toBe(200);
    await response.text();
  });

  test("skips disabled, signed out and account-limited logins without borrowing from another set", async () => {
    const disabled = (await signIn("disabled")).subscription;
    const signedOut = (await signIn("signed-out")).subscription;
    const limited = (await signIn("limited")).subscription;
    const spare = (await signIn("spare")).subscription;
    const outside = (await signIn("outside")).subscription;
    await client.mutation(profiles.subscriptions.setEnabled, { id: disabled.id, enabled: false });
    await client.mutation(profiles.manage.signOut, { id: signedOut.accounts[0]!.id });
    const a = await key(await register([disabled.id, signedOut.id, limited.id, spare.id]));
    const b = await key(await register([outside.id]));
    fake.script("limited", [{ kind: "limit", resetAt: Math.floor(Date.now() / 1000) + 60 }]);

    const start = messages().length;
    const capped = await stream(a);
    expect(capped.status).toBe(429);
    expect(capped.headers.get("anthropic-ratelimit-unified-5h-status")).toBe("rejected");
    await capped.text();
    const [first, second] = await Promise.all([stream(a), stream(b)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    await Promise.all([first.text(), second.text()]);
    expect(
      messages()
        .slice(start)
        .map(({ account }) => account)
        .sort(),
    ).toEqual(["limited", "outside", "spare"]);

    await client.mutation(profiles.subscriptions.setEnabled, { id: spare.id, enabled: false });
    await rejected(await stream(a), 503, "No usable Claude subscription in this set.");
    expect(messages()).toHaveLength(start + 3);
  });

  test("concurrent requests renew an expired login once and use the renewed token", async () => {
    const { account, subscription } = await signIn("expired", true);
    account.tokenDelayMs = 150;
    const a = await key(await register([subscription.id]));
    const b = await key(await register([subscription.id]));
    const start = messages().length;
    const responses = await Promise.all([stream(a), stream(b)]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    const renewals = fake.requests.filter(
      (record) =>
        record.account === account.id &&
        record.path.endsWith("/v1/oauth/token") &&
        (record.body as { grant_type: string }).grant_type === "refresh_token",
    );
    secrets.push(account.accessToken, account.refreshToken);
    expect(renewals).toHaveLength(1);
    expect(
      messages()
        .slice(start)
        .map(({ headers }) => headers.authorization),
    ).toEqual([`Bearer ${account.accessToken}`, `Bearer ${account.accessToken}`]);
  });

  test("an expired key cannot admit a new request", async () => {
    const expiring = await startWorkspace(build, fake.addresses, {
      turnCaller: true,
      patches: [{ find: "TURN_KEY_TTL_MS = 8 * 60 * 60000", replace: "TURN_KEY_TTL_MS = 250" }],
    });
    try {
      const caller = await expiring.owner();
      const set = await caller.mutation(api.turns.register, { subscriptions: [] });
      if ("failed" in set) throw new Error(set.kind);
      const address = await caller.action(api.turns.key, set);
      if ("failed" in address) throw new Error(address.kind);
      await expect
        .poll(async () => {
          const response = await stream(address);
          const body = await response.json();
          return [response.status, body.error.message];
        })
        .toEqual([401, "Turn key has expired."]);
      expect(expiring.output().includes(address.key)).toBe(false);
    } finally {
      await expiring.stop();
    }
  }, 45_000);

  test("disconnecting the client closes the upstream stream", async () => {
    const { subscription } = await signIn("disconnect");
    const address = await key(await register([subscription.id]));
    const controller = new AbortController();
    const response = await stream(address, "/v1/messages?disconnect=1", false, controller.signal);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect.poll(() => fake.disconnected).toContain("/anthropic/v1/messages?disconnect=1");
  });

  test(
    "installed Claude Code completes a turn with a path-prefixed base URL and a fake bearer key",
    { timeout: 45_000 },
    async (context) => {
      const home = await mkdtemp(join(tmpdir(), "tokamak-claude-proxy-"));
      const blocked = await blockingProxy();
      try {
        const env = cliEnvironment(home, blocked.url);
        let version;
        try {
          version = await run("claude", ["--version"], home, env);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return context.skip("Claude Code is not installed");
        }
        expect(version.code).toBe(0);
        const { account, subscription } = await signIn("cli");
        const address = await key(await register([subscription.id]));
        const result = await run(
          "claude",
          ["--bare", "-p", "--tools", "", "--model", model, "--no-session-persistence", "Say hello."],
          home,
          { ...env, ANTHROPIC_BASE_URL: address.address, ANTHROPIC_AUTH_TOKEN: address.key },
        );
        console.log(`Claude Code ${version.stdout.trim()}; exit ${result.code}`);
        expect(result.code, result.stderr.replaceAll(address.key, "[turn key]").slice(0, 1000)).toBe(0);
        expect(result.stdout).toContain("Fake reply.");
        expect(messages().at(-1)).toMatchObject({
          account: account.id,
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
      } finally {
        blocked.stop();
        await empty(home);
      }
    },
  );
});
