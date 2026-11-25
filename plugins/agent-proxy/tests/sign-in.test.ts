import { createApi, type FunctionReference, type TokamakClient } from "@tokamak/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startFakeCompanies } from "./fake-companies";
import { builds, type Workspace, startWorkspace } from "./workspace";

// Adding a Claude subscription, as the Profiles screen does it: through the
// functions `ai-profiles` gives its window, on a real server, against the
// fake Claude sign-in. Each test checks what a person or another plugin can
// see; the tables stay out of it. Runs once per server build that is built
// (CARGO_BUILD_JOBS=2 cargo build -p server -p tokamak-plugin-host, and the
// same with --no-default-features --target-dir target/cloud).

type Subscription = {
  id: string;
  label: string;
  plan: string;
  status: "ok" | "signed-out";
  reason?: string;
  accounts: { email?: string; organization?: string; status: string }[];
  models: { id: string; name: string }[];
};
type SignIn = { id: string; link: string; repair?: string };
type Failed = { failed: true; kind: string; data: { message: string } };
type Ref<K extends "query" | "mutation" | "action", A, R> = FunctionReference<K, A, R>;
const api = createApi<{
  subscriptions: {
    list: Ref<"query", Record<string, never>, { subscriptions: Subscription[]; signIns: SignIn[] }>;
    startSignIn: Ref<
      "action",
      { company: "anthropic"; method: "subscription"; repair?: string },
      SignIn | Failed
    >;
    finishSignIn: Ref<"action", { id: string; pasted: string }, Subscription | Failed>;
    cancelSignIn: Ref<"mutation", { id: string }, null>;
    setLabel: Ref<"mutation", { id: string; label: string }, null | Failed>;
    renew: Ref<"action", Record<string, never>, { renewed: number; signedOut: number }>;
  };
}>("ai-profiles", [
  "subscriptions:list",
  "subscriptions:startSignIn",
  "subscriptions:finishSignIn",
  "subscriptions:cancelSignIn",
  "subscriptions:setLabel",
  "subscriptions:renew",
]);

const available = builds();
if (!available.length)
  console.log("Skipping: build the server and tokamak-plugin-host to run the sign-in tests");

describe.skipIf(!available.length).each(available)("$name", (build) => {
  let fake: Awaited<ReturnType<typeof startFakeCompanies>>;
  let workspace: Workspace;
  /** Every answer the window got, to look for logins in afterwards. */
  const seen: unknown[] = [];

  beforeAll(async () => {
    fake = await startFakeCompanies({ delayMs: 1 });
    workspace = await startWorkspace(build, fake.addresses);
  }, 300_000);
  afterAll(async () => {
    await workspace?.stop();
    await fake?.stop();
  });

  const claude = { company: "anthropic", method: "subscription" } as const;
  async function call<A, R>(
    client: TokamakClient,
    kind: "query" | "mutation" | "action",
    ref: Ref<typeof kind, A, R>,
    args: A,
  ) {
    const result = await (client[kind] as (ref: unknown, args: A) => Promise<R>).call(client, ref, args);
    seen.push(result);
    return result;
  }
  const list = (client: TokamakClient) => call(client, "query", api.subscriptions.list, {});
  async function start(client: TokamakClient, repair?: string) {
    const started = await call(client, "action", api.subscriptions.startSignIn, {
      ...claude,
      ...(repair && { repair }),
    });
    if ("failed" in started) throw new Error(started.data.message);
    return started;
  }
  /** What the person's browser does: open the link, sign in, end on the callback link. */
  async function signInOnPage(link: string, account: string) {
    fake.nextSignIn(account);
    const page = await fetch(link, { redirect: "manual" });
    expect(page.status).toBe(302);
    return page.headers.get("location")!;
  }
  const finish = (client: TokamakClient, id: string, pasted: string) =>
    call(client, "action", api.subscriptions.finishSignIn, { id, pasted });

  test("the link asks Claude for a subscription login with PKCE and state", async () => {
    const client = await workspace.owner();
    const { link } = await start(client);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe(fake.addresses.anthropic.authorize);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      code: "true",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      response_type: "code",
      redirect_uri: "http://localhost:54545/callback",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(
      expect.arrayContaining(["user:inference", "user:profile", "org:create_api_key"]),
    );
    // A 43-character S256 challenge of a 32-byte verifier, and a state of the same size.
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
  });

  test("a pasted callback link adds the subscription with its plan, email, organisation and models", async () => {
    fake.addAccount("anthropic", "personal");
    const client = await workspace.owner();
    const { id, link } = await start(client);
    const callback = await signInOnPage(link, "personal");
    const added = await finish(client, id, callback);
    expect(added).toMatchObject({
      plan: "Pro",
      status: "ok",
      accounts: [{ email: "personal@example.test", organization: "Fake organization", status: "ok" }],
      models: [{ id: "claude-sonnet-4-6", name: "Fake Sonnet" }],
    });
    // The fake checked the verifier against the challenge and the state against the link.
    expect(fake.requests.at(-3)?.body).toMatchObject({
      grant_type: "authorization_code",
      state: new URL(link).searchParams.get("state"),
    });
    const { id: subscription } = added as Subscription;
    expect(
      await call(client, "mutation", api.subscriptions.setLabel, { id: subscription, label: " Personal " }),
    ).toBeNull();
    const after = await list(client);
    expect(after.signIns).toEqual([]);
    expect(after.subscriptions).toEqual([expect.objectContaining({ id: subscription, label: "Personal" })]);
  });

  test("Claude's code#state, pasted after the dialog was closed and opened again, completes too", async () => {
    const account = fake.addAccount("anthropic", "work");
    const first = await workspace.owner();
    // The screen lists live: the waiting sign-in shows as soon as it starts.
    let shown: { signIns: SignIn[] } | undefined;
    let wake = () => {};
    const stop = first.subscribe(api.subscriptions.list, {}, (event) => {
      if ("value" in event) shown = event.value;
      wake();
    });
    const { id, link } = await start(first);
    while (!shown?.signIns.some((signIn) => signIn.id === id))
      await new Promise<void>((done) => (wake = done));
    stop();
    // The page shows the code and the state; the person closes the window and comes back.
    await signInOnPage(link, "work");
    const reopened = await workspace.owner();
    const { signIns } = await list(reopened);
    expect(signIns).toEqual([expect.objectContaining({ id, link })]);
    const added = await finish(reopened, id, `${account.code}#${new URL(link).searchParams.get("state")}`);
    expect(added).toMatchObject({ accounts: [{ email: "work@example.test" }] });
    expect((await list(reopened)).signIns).toEqual([]);
  });

  test("a code from another sign-in is refused and the sign-in keeps waiting", async () => {
    const client = await workspace.owner();
    const { id } = await start(client);
    const wrong = await finish(client, id, "fake-x-code#not-this-state");
    expect(wrong).toMatchObject({ failed: true, kind: "WrongSignIn" });
    expect((await list(client)).signIns.map((signIn) => signIn.id)).toContain(id);
    await call(client, "mutation", api.subscriptions.cancelSignIn, { id });
  });

  test("cancel and a refused code leave nothing behind and say why", async () => {
    const client = await workspace.owner();
    const before = (await list(client)).subscriptions.length;

    const cancelled = await start(client);
    const callback = await signInOnPage(cancelled.link, "personal");
    await call(client, "mutation", api.subscriptions.cancelSignIn, { id: cancelled.id });
    expect(await finish(client, cancelled.id, callback)).toMatchObject({
      failed: true,
      kind: "Cancelled",
      data: { message: expect.stringMatching(/no longer waiting/) },
    });

    fake.addAccount("anthropic", "rejected", { signIn: "reject-code" });
    const refused = await start(client);
    expect(await finish(client, refused.id, await signInOnPage(refused.link, "rejected"))).toMatchObject({
      failed: true,
      kind: "Refused",
      data: { message: expect.stringMatching(/did not accept that code/) },
    });
    const after = await list(client);
    expect(after.signIns).toEqual([]);
    expect(after.subscriptions).toHaveLength(before);
  });

  test("an expiring login is renewed; one Claude will not renew turns Signed out and is repaired in place", async () => {
    const account = fake.addAccount("anthropic", "renewing", { signIn: "expired" });
    const client = await workspace.owner();
    const { id, link } = await start(client);
    const added = (await finish(client, id, await signInOnPage(link, "renewing"))) as Subscription;
    await call(client, "mutation", api.subscriptions.setLabel, { id: added.id, label: "Renewing" });

    expect(await call(client, "action", api.subscriptions.renew, {})).toEqual({ renewed: 1, signedOut: 0 });
    expect(fake.requests.at(-1)).toMatchObject({
      path: "/anthropic/v1/oauth/token",
      account: "renewing",
      body: { grant_type: "refresh_token", refresh_token: "fake-renewing-refresh" },
    });
    // Renewed for an hour: nothing is due now.
    expect(await call(client, "action", api.subscriptions.renew, {})).toEqual({ renewed: 0, signedOut: 0 });

    // Signed in again later with a login that expires and that Claude then refuses to renew.
    account.signIn = "expired";
    const again = await start(client, added.id);
    const repairedOnce = await finish(client, again.id, await signInOnPage(again.link, "renewing"));
    expect(repairedOnce).toMatchObject({ id: added.id, status: "ok" });
    account.signIn = "refuse-renewal";
    expect(await call(client, "action", api.subscriptions.renew, {})).toEqual({ renewed: 0, signedOut: 1 });
    const signedOut = (await list(client)).subscriptions.find((item) => item.id === added.id);
    expect(signedOut).toMatchObject({ status: "signed-out", reason: expect.stringMatching(/Sign in again/) });

    // "Sign in" on the card: the same subscription, its label kept, signed in again.
    account.signIn = "success";
    const repair = await start(client, added.id);
    expect(repair.repair).toBe(added.id);
    const repaired = await finish(client, repair.id, await signInOnPage(repair.link, "renewing"));
    expect(repaired).toMatchObject({ id: added.id, label: "Renewing", status: "ok" });
    expect((await list(client)).subscriptions.filter((item) => item.id === added.id)).toHaveLength(1);
  });

  test("another member of the server sees and changes none of it", async () => {
    const owner = await workspace.owner();
    const waiting = await start(owner);
    const mine = await list(owner);
    expect(mine.subscriptions.length).toBeGreaterThan(0);

    const other = await workspace.member("alex");
    expect(await list(other)).toEqual({ subscriptions: [], signIns: [] });
    await call(other, "mutation", api.subscriptions.cancelSignIn, { id: waiting.id });
    expect(
      await call(other, "mutation", api.subscriptions.setLabel, {
        id: mine.subscriptions[0]!.id,
        label: "Mine now",
      }),
    ).toMatchObject({ failed: true, kind: "Gone" });
    expect(await finish(other, waiting.id, "anything")).toMatchObject({ failed: true, kind: "Cancelled" });
    expect(await list(owner)).toEqual(mine);
    await call(owner, "mutation", api.subscriptions.cancelSignIn, { id: waiting.id });
  });

  test("no login reaches the window, ai-profiles or the server's output", () => {
    const secrets = [
      ...fake.requests.flatMap(({ body }) => {
        const fields = body as Record<string, unknown> | undefined;
        return [fields?.code_verifier, fields?.refresh_token];
      }),
      ...["personal", "work", "renewing"].flatMap((id) => [`fake-${id}-access`, `fake-${id}-refresh`]),
    ].filter((value): value is string => typeof value === "string");
    expect(secrets.length).toBeGreaterThan(6);
    const answers = JSON.stringify(seen);
    const output = workspace.output();
    for (const secret of secrets) {
      expect(answers).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
  });
});
