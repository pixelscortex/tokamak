import { api as extra } from "./fixtures/query-hooks/z-extra/src/server/_generated/api";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import {
  InProcessTransport,
  RemoteFunctionError,
  TokamakClient,
  type Event,
  type Id,
} from "../../sdk/src/index";
import { api as team } from "./fixtures/query-hooks/team/src/server/_generated/api";
import { api as moderation } from "./fixtures/query-hooks/moderation/src/server/_generated/api";

const lines = createInterface({ input: process.stdin });
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
let deliver: (event: Event) => void;
let reloaded: () => void;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.reloaded) reloaded();
  else deliver(message.event);
});

const client = new TokamakClient(
  new InProcessTransport({
    send: (request) => send({ request }),
    listen(onEvent) {
      deliver = onEvent;
      return () => {};
    },
    close() {},
  }),
);

const { list } = team.users;
const thread = "chat/threads:hooks" as Id<"threads">;
const alice = await client.mutation(team.users.add, { name: "Alice" });
await client.mutation(team.users.add, { name: "Mal" });

async function transforms_arguments_and_results_with_identity() {
  assert.deepEqual(await client.query(list, { text: "  Ali ", thread }), [
    { name: "Alice", detail: `Ali|member-1|member|${thread}|1` },
  ]);
  await assert.rejects(client.query(list, { text: "", mode: "blocked" }), (error: RemoteFunctionError) => {
    assert.equal(error.plugin, "moderation");
    assert.equal(error.hook, "policy:moderate");
    assert.equal(error.stage, "before");
    assert.equal(error.kind, "forbidden");
    assert.deepEqual(error.data, { reason: "members" });
    assert.doesNotMatch(error.message, /TARGET HANDLER RAN/);
    return true;
  });
}

async function names_policy_errors_and_enforces_read_only_scope() {
  for (const [mode, expected, text] of [
    ["wrong-args", /args\.text: expected string/],
    ["added-arg", /args\.additional: unexpected field/],
    ["throw", /policy threw/],
    ["stalled", /timeout|deadline|exceeded/i],
    ["foreign", /does not own that record/, alice],
    ["write", /not a function/],
    ["raw-write", /does not own that record/],
    ["wrong-result", /result: expected array/],
    ["added-field", /result\[0\]\.additional: unexpected field/],
    ["recursive", /depth limit/],
  ] as const) {
    await assert.rejects(client.query(list, { text: text ?? "", mode }), (error: RemoteFunctionError) => {
      assert.match(error.message, /Hook moderation\/policy:moderate \(team\/users:list/);
      assert.equal(error.plugin, "moderation");
      assert.match(error.message, expected);
      if (mode === "recursive") {
        assert.equal(error.kind, "hookDepthLimit");
        assert.equal(error.message.match(/team\/users:list/g)?.length, 1);
      }
      if (mode === "throw") {
        assert.equal(error.kind, "hookException");
        assert.equal(error.data, "policy threw: depth limit is just text");
        assert.doesNotMatch(JSON.stringify(error), / at |policy\.ts|tokamak-module/);
      }
      return true;
    });
  }
}

async function chains_two_plugins_and_hooks_server_calls() {
  assert.deepEqual(await client.query(list, { text: " A ", mode: "chain" }), [
    { name: "Alice", detail: "Al|member-1|member||1|extra" },
  ]);
  assert.deepEqual(await client.query(moderation.policy.delegated, { text: "  Ali  " }), [
    { name: "Alice", detail: "Ali|member-1|member||2" },
  ]);
}

async function validates_profiles_and_preserves_nested_call_budget() {
  assert.deepEqual(await client.query(team.users.explicit, {}), { status: "active" });
  assert.deepEqual(await client.query(team.users.profile, { mode: "ok" }), {
    title: "Title",
    alias: "Alias",
    status: "active",
    labels: ["new"],
    extras: { fresh: ["data"] },
    location: ["new", 1, true],
  });
  for (const field of ["title", "alias", "status", "location"]) {
    await assert.rejects(
      client.query(team.users.profile, { mode: `bad-${field}` }),
      (error: RemoteFunctionError) => {
        assert.equal(error.plugin, "moderation");
        assert.equal(error.stage, "after");
        assert.equal(error.kind, "invalidHookResult");
        assert.match(String(error.data), new RegExp(`result\\.${field}`));
        return true;
      },
    );
  }
  assert.equal(await client.query(moderation.policy.fanout, { count: 64 }), 64);
  await assert.rejects(client.query(moderation.policy.fanout, { count: 65 }), {
    plugin: "moderation",
    kind: "hookDepthLimit",
  });
  const rows = [{ name: "Alice", detail: "Ali|member-1|member||2" }];
  assert.deepEqual(await client.mutation(moderation.policy.fromMutation, {}), rows);
  const failure = { kind: "forbidden", plugin: "moderation", data: { reason: "members" } };
  assert.deepEqual(await client.query(moderation.policy.catchFailure, {}), failure);
  assert.deepEqual(await client.action(moderation.policy.fromAction, {}), { rows, ...failure });
}

async function accepts_structural_rows_and_bounds_hook_fanout() {
  const rows = await client.query(team.users.rows, {});
  assert.deepEqual(
    rows.map(({ name }) => name),
    ["Alice"],
  );
  assert.equal((rows[0] as { _id?: string })._id, alice);
  assert.deepEqual(await client.query(team.users.viaContract, {}), [
    { name: "Alice", detail: "Ali|member-1|member||3" },
  ]);
  await assert.rejects(client.query(moderation.policy.hookBudget, {}), {
    plugin: "moderation",
    kind: "hookDepthLimit",
    data: "delegated module count budget exceeded",
  });
  await assert.rejects(
    client.query(moderation.policy.stallsAfterCaughtHook, {}),
    (error: RemoteFunctionError) => {
      assert.equal(error.plugin, undefined);
      assert.match(error.message, /timeout|deadline|exceeded/i);
      return true;
    },
  );
}

async function live_query_tracks_owner_and_hook_tables_then_uninstalls() {
  type Row = { name: string; detail: string };
  const updates: Row[][] = [];
  let wake: (() => void) | undefined;
  const close = client.subscribe(list, { text: "  " }, (event) => {
    if ("error" in event) throw event.error;
    updates.push(event.value);
    wake?.();
  });
  async function next() {
    if (!updates.length) await new Promise<void>((resolve) => (wake = resolve));
    return updates.shift()!;
  }
  const names = async () => (await next()).map(({ name }) => name).sort();
  assert.deepEqual(await names(), ["Alice", "Mal"]);
  await client.mutation(team.users.add, { name: "Bob" });
  assert.deepEqual(await names(), ["Alice", "Bob", "Mal"]);
  await client.mutation(moderation.policy.ban, { name: "Mal" });
  assert.deepEqual(await names(), ["Alice", "Bob"]);

  await new Promise<void>((resolve) => {
    reloaded = resolve;
    send({ uninstall: true });
  });
  // The subscription still has the original whitespace arguments. Removing the
  // hook stops trimming them and stops filtering the ban on subsequent calls.
  assert.deepEqual(await next(), []);
  assert.deepEqual(await client.query(list, { text: "Mal" }), [{ name: "Mal", detail: "" }]);
  await new Promise<void>((resolve) => {
    reloaded = resolve;
    send({ reinstall: true });
  });
  assert.ok((await names()).includes("Alice"));
  close();
}

async function mutation_hooks_transform_and_share_the_save() {
  assert.equal(await client.mutation(team.users.guarded, { name: "  saved " }), "SAVED");
  await client.mutation(team.users.catchQueryHook, {});
  await client.mutation(team.users.useHidden, { name: "private" });
  const names = async () => (await client.query(list, { text: "" })).map(({ name }) => name).sort();
  const audit = async () => client.query(moderation.policy.audit, {});
  const saved = await names();
  assert.ok(saved.includes("saved"));
  assert.ok(saved.includes("query-fallback"));
  assert.ok(saved.includes("private-hooked"));
  const events = await client.query(extra.extra.events, {});
  assert.equal(events.filter((name) => name === "audit:  saved ").length, 1);
  assert.equal(events.filter((name) => name === "after:saved").length, 1);
  const entries = await audit();
  assert.ok(entries.includes("audit:  saved "));
  assert.ok(entries.includes("after:saved"));

  await assert.rejects(client.mutation(team.users.guarded, { name: "blocked", mode: "before-fails" }), {
    plugin: "moderation",
    hook: "policy:logSave",
    stage: "before",
    kind: "limitReached",
    data: { maximum: 100 },
  });
  await assert.rejects(
    client.mutation(team.users.guarded, { name: "owner", mode: "owner-fails" }),
    /owner failed/,
  );
  await assert.rejects(client.mutation(team.users.guarded, { name: "after", mode: "after-fails" }), {
    plugin: "moderation",
    stage: "after",
    kind: "hookException",
  });
  await assert.rejects(client.mutation(team.users.catchGuarded, {}), {
    plugin: "moderation",
    stage: "after",
    kind: "hookException",
  });
  assert.deepEqual(await names(), saved);
  assert.deepEqual(await audit(), entries);
  assert.deepEqual(await client.query(extra.extra.events, {}), events);
}

try {
  if (process.env.TOKAMAK_HOOK_BENCHMARK === "1") {
    const { measureHooks } = await import("./hook-measurement");
    await measureHooks(client);
  } else {
    await transforms_arguments_and_results_with_identity();
    await names_policy_errors_and_enforces_read_only_scope();
    await chains_two_plugins_and_hooks_server_calls();
    await validates_profiles_and_preserves_nested_call_budget();
    await accepts_structural_rows_and_bounds_hook_fanout();
    await live_query_tracks_owner_and_hook_tables_then_uninstalls();
    await mutation_hooks_transform_and_share_the_save();
  }
  send({ done: true });
} finally {
  lines.close();
  process.stdin.pause();
}
