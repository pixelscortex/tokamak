import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { companyAddresses } from "../src/server/addresses";
import { startFakeCompanies } from "./fake-companies";
import { cleanFixture, createRecorder, type Fixture } from "./fake-companies/recorder";

test("both sign-in forms return a callback, reject bad codes, and let tests control expiration and renewal", async () => {
  const fake = await startFakeCompanies();
  try {
    const addresses = companyAddresses(fake.addresses);
    for (const company of ["anthropic", "openai"] as const) {
      const account = fake.addAccount(company, company, "expired");
      const urls = addresses[company];
      const authorize = new URL(urls.authorize);
      authorize.search = new URLSearchParams({
        redirect_uri: "http://127.0.0.1/callback",
        state: "fixture",
      }).toString();
      const callback = await fetch(authorize, { redirect: "manual" });
      expect(callback.status).toBe(302);
      const query = new URL(callback.headers.get("location")!).searchParams;
      expect(query.get("state")).toBe("fixture");

      const postToken = (fields: Record<string, string>) =>
        fetch(urls.token, {
          method: "POST",
          ...(company === "anthropic"
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(fields) }
            : { body: new URLSearchParams(fields) }),
        });
      const exchange = () => postToken({ grant_type: "authorization_code", code: query.get("code")! });
      const login = (await (await exchange()).json()) as { access_token: string; refresh_token: string };
      expect(login).toMatchObject({ access_token: account.accessToken, expires_in: -1 });
      const models = () =>
        fetch(urls.api + (company === "anthropic" ? "/v1/models" : "/codex/models"), {
          headers: { authorization: `Bearer ${account.accessToken}` },
        });
      expect((await models()).status).toBe(401);

      const renew = () => postToken({ grant_type: "refresh_token", refresh_token: login.refresh_token });
      account.signIn = "refuse-renewal";
      expect((await renew()).status).toBe(400);
      account.signIn = "reject-code";
      expect((await exchange()).status).toBe(400);
      expect(await (await renew()).json()).toMatchObject({ expires_in: 3600 });
      expect(account.accessToken).not.toBe(login.access_token);
      expect((await models()).status).toBe(200);
      expect(fake.requests.filter((request) => request.account === company)).toHaveLength(7);
    }
  } finally {
    await fake.stop();
  }
});

test("only a turn for the selected account consumes its script, and a partial limit follows visible output", async () => {
  const fake = await startFakeCompanies();
  try {
    for (const company of ["anthropic", "openai"] as const) {
      const a = fake.addAccount(company, `${company}-a`);
      const b = fake.addAccount(company, `${company}-b`);
      const resetAt = Math.floor(Date.now() / 1000) + 120;
      fake.script(a.id, [
        { kind: "limit", resetAt },
        { kind: "partial-limit", resetAt },
        { kind: "signed-out" },
        { kind: "overloaded" },
      ]);
      const api = fake.addresses[company].api;
      const turn = (account: typeof a) =>
        fetch(api + (company === "anthropic" ? "/v1/messages" : "/codex/responses"), {
          method: "POST",
          headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture", stream: true }),
        });
      expect(await (await turn(b)).text()).toContain(
        company === "anthropic" ? "message_stop" : "response.completed",
      );
      const limited = await turn(a);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      const partial = await turn(a);
      expect(partial.status).toBe(200);
      const body = await partial.text();
      const delta = body.indexOf("Fake ");
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(body.indexOf("Fake limit")).toBeGreaterThan(delta);
      expect(body).not.toContain("reply.");
      expect((await turn(a)).status).toBe(401);
      expect((await turn(a)).status).toBe(company === "anthropic" ? 529 : 503);
      expect(fake.requests.at(-1)).toMatchObject({
        account: a.id,
        headers: { authorization: `Bearer ${a.accessToken}` },
        body: { model: "fixture", stream: true },
      });
    }
  } finally {
    await fake.stop();
  }
});

test("the cleaner correlates synthetic credentials and removes identity and message text before replay", async () => {
  const fake = await startFakeCompanies();
  const dir = await mkdtemp(join(tmpdir(), "fake-company-recording-"));
  const filename = join(dir, "fixture.json");
  try {
    const login = {
      access_token: "sample-secret",
      account: { email_address: "example@example.test" },
      organization: { name: "Sample Organization" },
    };
    const responseText = 'event: delta\ndata: {"delta":"Sample answer"}\n\n';
    const recorder = createRecorder(async (request) =>
      new URL(String((request as Request).url)).pathname.endsWith("/token")
        ? Response.json(login, { headers: { "set-cookie": "sample-cookie" } })
        : new Response(responseText, { headers: { "content-type": "text/event-stream" } }),
    );
    await recorder.fetch("https://fixture.invalid/v1/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ code: "sample-code" }),
    });
    await recorder.fetch("https://fixture.invalid/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer sample-secret", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ content: "Sample question" }] }),
    });
    await recorder.save(filename);
    const saved = await readFile(filename, "utf8");
    for (const privateText of [
      "sample-secret",
      "example@example.test",
      "Sample Organization",
      "Sample answer",
      "sample-code",
      "Sample question",
      "sample-cookie",
    ])
      expect(saved).not.toContain(privateText);

    const fixture = JSON.parse(saved) as Fixture;
    const { access_token } = JSON.parse(fixture.exchanges[0].response.chunks[0]);
    expect(fixture.exchanges[1].request.headers.authorization).toBe(`Bearer ${access_token}`);
    const split: Fixture = {
      exchanges: [
        {
          ...fixture.exchanges[1],
          response: {
            ...fixture.exchanges[1].response,
            chunks: [responseText.slice(0, 25), responseText.slice(25)],
          },
        },
      ],
    };
    expect(cleanFixture(split).exchanges[0].response.chunks).toEqual([
      'event: delta\ndata: {"delta":"[sample text]"}\n\n',
    ]);
    fake.replay(fixture);
    const api = fake.addresses.anthropic.api;
    expect(await (await fetch(api + "/v1/oauth/token", { method: "POST" })).json()).toMatchObject({
      access_token,
    });
    expect(await (await fetch(api + "/v1/messages", { method: "POST" })).text()).toContain("[sample text]");
  } finally {
    await fake.stop();
    await unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(dir);
  }
});
