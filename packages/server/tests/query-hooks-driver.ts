import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { InProcessTransport, RemoteFunctionError, TokamakClient, type Event, type Id } from "../../sdk/src/index";
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
      if (mode === "recursive") assert.equal(error.message.match(/team\/users:list/g)?.length, 1);
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
  assert.deepEqual(await client.query(team.users.profile, { mode: "ok" }), {
    title: "Title", alias: "Alias", status: "active", labels: ["new"],
  });
  for (const field of ["title", "alias", "status"]) {
    await assert.rejects(client.query(team.users.profile, { mode: `bad-${field}` }), (error: RemoteFunctionError) => {
      assert.equal(error.plugin, "moderation");
      assert.equal(error.stage, "after");
      assert.equal(error.kind, "invalidHookResult");
      assert.match(String(error.data), new RegExp(`result\\.${field}`));
      return true;
    });
  }
  assert.equal(await client.query(moderation.policy.fanout, {}), 70);
  const rows = [{ name: "Alice", detail: "Ali|member-1|member||2" }];
  assert.deepEqual(await client.mutation(moderation.policy.fromMutation, {}), rows);
  assert.deepEqual(await client.action(moderation.policy.fromAction, {}), {
    rows, kind: "forbidden", plugin: "moderation", data: { reason: "members" },
  });
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
  close();
}

try {
  await transforms_arguments_and_results_with_identity();
  await names_policy_errors_and_enforces_read_only_scope();
  await chains_two_plugins_and_hooks_server_calls();
  await validates_profiles_and_preserves_nested_call_budget();
  await live_query_tracks_owner_and_hook_tables_then_uninstalls();
  send({ done: true });
} finally {
  lines.close();
  process.stdin.pause();
}
