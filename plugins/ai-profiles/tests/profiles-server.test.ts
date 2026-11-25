// @vitest-environment node
import { isFailure, type TokamakClient } from "@tokamak/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startFakeCompanies } from "../../agent-proxy/tests/fake-companies";
import { builds, startWorkspace, type Workspace } from "../../agent-proxy/tests/workspace";
import { api } from "../src/server/_generated/api";

// Profiles on a real server, through the functions the Profiles screen calls.
// Subscriptions are made the way a person makes them, against the fake Claude
// sign-in. Each test checks what a person can see: the tables stay out of it.
// Runs once per server build that is built (see agent-proxy's sign-in tests).
//
// agent-proxy cannot remove a subscription yet (TKM-265), so the installed copy
// here stops listing one labelled "Removed": to ai-profiles that is the same as
// the subscription being gone.

const available = builds();
if (!available.length) console.log("Skipping: build the server and tokamak-plugin-host to run the profile tests");

/** A failure a person can read: one line, no stack trace, no source path. */
const plain = (kind: string) => ({ failed: true, kind, data: expect.objectContaining({ message: expect.stringMatching(/^[^\n/]*$/) }) });

describe.skipIf(!available.length).each(available)("$name", (build) => {
  let fake: Awaited<ReturnType<typeof startFakeCompanies>>;
  let workspace: Workspace;
  let owner: TokamakClient;
  /** Three of the owner's subscriptions, oldest first. */
  let subs: string[];

  async function subscribe(client: TokamakClient, account: string) {
    fake.addAccount("anthropic", account);
    const started = await client.action(api.subscriptions.startSignIn, {
      company: "anthropic",
      method: "subscription",
    });
    if (isFailure(started)) throw new Error(started.data.message);
    fake.nextSignIn(account);
    const page = await fetch(started.link, { redirect: "manual" });
    const added = await client.action(api.subscriptions.finishSignIn, {
      id: started.id,
      pasted: page.headers.get("location")!,
    });
    if (isFailure(added)) throw new Error(added.data.message);
    return added.id;
  }
  const list = (client: TokamakClient) => client.query(api.profiles.list, {});
  async function create(client: TokamakClient, name: string, code: string) {
    const made = await client.mutation(api.profiles.create, { name, code });
    if (isFailure(made)) throw new Error(made.data.message);
    return made;
  }

  beforeAll(async () => {
    fake = await startFakeCompanies({ delayMs: 1 });
    workspace = await startWorkspace(build, fake.addresses, {
      patches: [
        {
          find: "subscriptions: subscriptions.sort(",
          replace: 'subscriptions: subscriptions.filter((row) => row.label !== "Removed").sort(',
        },
      ],
    });
    owner = await workspace.owner();
    subs = [];
    for (const account of ["first", "second", "third"]) subs.push(await subscribe(owner, account));
  }, 300_000);
  afterAll(async () => {
    await workspace?.stop();
    await fake?.stop();
  });

  test("a profile has a name and a code of up to four characters, upper case and the person's own", async () => {
    const made = await create(owner, "  Personal  work ", " pers ");
    expect(made).toMatchObject({ name: "Personal work", code: "PERS", subscriptions: [] });
    // The code is unique per person whatever its case; too long, empty or odd ones are refused.
    expect(await owner.mutation(api.profiles.create, { name: "Other", code: "Pers" })).toMatchObject(
      plain("Taken"),
    );
    for (const code of ["ACMEX", "", "A-B", "é"])
      expect(await owner.mutation(api.profiles.create, { name: "Other", code })).toMatchObject(
        plain("Invalid"),
      );
    expect(await owner.mutation(api.profiles.create, { name: "  ", code: "NONE" })).toMatchObject(
      plain("Invalid"),
    );
    expect((await list(owner)).map((profile) => profile.code)).toEqual(["PERS"]);
  });

  test("subscriptions go in at the drop position, move, come out, and can be in several profiles", async () => {
    const [a, b, c] = subs as [string, string, string];
    const work = await create(owner, "Work", "work");
    const order = async () => (await list(owner)).find((profile) => profile.id === work.id)!.subscriptions;

    await owner.mutation(api.profiles.add, { profile: work.id, subscription: a });
    await owner.mutation(api.profiles.add, { profile: work.id, subscription: b, at: 0 });
    await owner.mutation(api.profiles.add, { profile: work.id, subscription: c, at: 1 });
    expect(await order()).toEqual([b, c, a]);
    // Already in: refused, and nothing moves.
    expect(await owner.mutation(api.profiles.add, { profile: work.id, subscription: a, at: 0 })).toMatchObject(
      plain("AlreadyAdded"),
    );
    await owner.mutation(api.profiles.move, { profile: work.id, subscription: a, to: 0 });
    expect(await order()).toEqual([a, b, c]);
    await owner.mutation(api.profiles.move, { profile: work.id, subscription: a, to: 99 });
    expect(await order()).toEqual([b, c, a]);
    await owner.mutation(api.profiles.remove, { profile: work.id, subscription: c });
    expect(await order()).toEqual([b, a]);

    // The same subscription in a second profile, and still in the first.
    const sandbox = await create(owner, "Sandbox", "sbox");
    await owner.mutation(api.profiles.add, { profile: sandbox.id, subscription: a });
    const profiles = await list(owner);
    expect(profiles.filter((profile) => profile.subscriptions.includes(a)).map((p) => p.code)).toEqual([
      "WORK",
      "SBOX",
    ]);
  });

  test("a subscription agent-proxy no longer lists drops out of every profile, and stays out", async () => {
    const gone = await subscribe(owner, "fourth");
    const kept = subs[0]!;
    const one = await create(owner, "One", "ONE");
    const two = await create(owner, "Two", "TWO");
    for (const profile of [one, two]) {
      await owner.mutation(api.profiles.add, { profile: profile.id, subscription: gone });
      await owner.mutation(api.profiles.add, { profile: profile.id, subscription: kept });
    }
    await owner.mutation(api.subscriptions.setLabel, { id: gone, label: "Removed" });
    const codes = async () =>
      (await list(owner)).filter((p) => p.code === "ONE" || p.code === "TWO").map((p) => p.subscriptions);
    expect(await codes()).toEqual([[kept], [kept]]);
    // It cannot be added while gone. Any write then clears it from every
    // profile, so it does not come back when agent-proxy lists it again.
    expect(await owner.mutation(api.profiles.add, { profile: one.id, subscription: gone })).toMatchObject(
      plain("NotFound"),
    );
    await owner.mutation(api.profiles.move, { profile: one.id, subscription: kept, to: 0 });
    await owner.mutation(api.subscriptions.setLabel, { id: gone, label: "Back" });
    expect(await codes()).toEqual([[kept], [kept]]);
  });

  test("ids of another table, or malformed, get a plain answer and change nothing", async () => {
    const before = await list(owner);
    const profile = before[0]!.id;
    const subscription = subs[0]!;
    for (const id of [subscription, "profiles", "ai-profiles/profiles:", "ai-profiles/other:abc", ""]) {
      expect(await owner.mutation(api.profiles.add, { profile: id, subscription: subs[1]! })).toMatchObject(
        plain("NotFound"),
      );
      expect(await owner.mutation(api.profiles.remove, { profile: id, subscription })).toMatchObject(
        plain("NotFound"),
      );
    }
    for (const id of [profile, "agent-proxy/signIns:abc", "nonsense"])
      expect(await owner.mutation(api.profiles.add, { profile, subscription: id })).toMatchObject(
        plain("NotFound"),
      );
    expect(await list(owner)).toEqual(before);
  });

  test("another member sees none of them and can change none, and has codes of their own", async () => {
    const before = await list(owner);
    const work = before.find((profile) => profile.code === "WORK")!;
    const other = await workspace.member("alex");
    expect(await list(other)).toEqual([]);
    const first = work.subscriptions[0]!;
    expect(await other.mutation(api.profiles.remove, { profile: work.id, subscription: first })).toMatchObject(
      plain("NotFound"),
    );
    expect(await other.mutation(api.profiles.move, { profile: work.id, subscription: first, to: 1 })).toMatchObject(
      plain("NotFound"),
    );
    // Their own profile with the same code, and the owner's subscription cannot go in it.
    const theirs = await create(other, "Work", "WORK");
    expect(await other.mutation(api.profiles.add, { profile: theirs.id, subscription: first })).toMatchObject(
      plain("NotFound"),
    );
    expect(await list(owner)).toEqual(before);
  });

  test("profiles survive a restart of the server", async () => {
    const before = await list(owner);
    expect(before.length).toBeGreaterThan(0);
    await workspace.restart();
    owner = await workspace.owner();
    expect(await list(owner)).toEqual(before);
  });
});
