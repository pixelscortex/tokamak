/** TKM-10 SDK lifecycle regression: real Solid ownership and SDK client, with a
 * deliberately late transport at the boundary. Native end-to-end is separate. */
import assert from "node:assert/strict";
import { createRoot, createSignal } from "solid-js";
import { useQuery } from "../../packages/sdk/solid";
import { createApi, TokamakClient } from "../../packages/sdk/src/index";
import type { ClientTransport, SubscriptionEvent } from "../../packages/sdk/src/client";
import type { FunctionReference } from "../../packages/sdk/src/api";
import type { JsonValue } from "../../packages/sdk/src/values";

const api = createApi<{ todo: { list: FunctionReference<"query", { filter: string }, string[]> } }>();
type Registration = {
  args: JsonValue;
  notify(event: SubscriptionEvent<JsonValue>): void;
  stops: number;
};
const registrations: Registration[] = [];
let registrationFailure: unknown = undefined;
const transport: ClientTransport = {
  query: async () => null,
  mutation: async () => null,
  subscribe(_name, args, notify) {
    if (registrationFailure) throw registrationFailure;
    const entry = { args, notify, stops: 0 };
    registrations.push(entry);
    return () => {
      entry.stops++;
      // Real native retirement may already have a callback queued.
      notify({ value: ["during cleanup"] });
    };
  },
};
const client = new TokamakClient(transport);
let dispose!: () => void;
let change!: (filter: string) => void;
let state!: ReturnType<typeof useQuery<{ filter: string }, string[]>>;
createRoot((stop) => {
  dispose = stop;
  const [filter, setFilter] = createSignal("first");
  change = setFilter;
  state = useQuery(client, api.todo.list, () => ({ filter: filter() }));
});

// Acceptance: loading is distinct from empty data, error delivery ends loading,
// and a later successful live rerun clears the error rather than poisoning UI.
assert.equal(registrations.length, 1);
assert.equal(state.loading(), true);
assert.equal(state.data(), undefined);
registrations[0]!.notify({ error: new Error("query failed") });
assert.equal(state.loading(), false);
assert.equal(state.error()?.message, "query failed");
registrations[0]!.notify({ value: ["saved"] });
assert.deepEqual(state.data(), ["saved"]);
assert.equal(state.error(), undefined);

// Failure mode: argument invalidation must dispose before replacement and ignore
// both a synchronous cleanup callback and a queued update from the old stream.
change("second");
assert.equal(registrations.length, 2);
assert.equal(registrations[0]!.stops, 1);
assert.deepEqual(registrations[1]!.args, { filter: "second" });
assert.equal(state.loading(), true);
assert.equal(state.data(), undefined);
registrations[0]!.notify({ value: ["stale"] });
assert.equal(state.data(), undefined);
registrations[1]!.notify({ value: [] });
assert.deepEqual(state.data(), []);
assert.equal(state.loading(), false);

// Failure mode: disposal/remount cannot retain a subscription or accept a late
// callback into the old owner; the next mount owns exactly one fresh stream.
dispose();
dispose();
assert.equal(registrations[1]!.stops, 1);
registrations[1]!.notify({ error: new Error("after disposal") });
assert.equal(state.error(), undefined);
assert.deepEqual(state.data(), []);
createRoot((stop) => {
  dispose = stop;
  state = useQuery(client, api.todo.list, () => ({ filter: "remount" }));
});
assert.equal(registrations.length, 3);
dispose();
assert.equal(registrations[2]!.stops, 1);

// Failure mode: synchronous admission failure is an observable error state, not
// an escaping effect exception or an indefinitely loading query.
registrationFailure = new Error("connection retired");
createRoot((stop) => {
  dispose = stop;
  state = useQuery(client, api.todo.list, () => ({ filter: "closed" }));
});
assert.equal(state.loading(), false);
assert.equal(state.error()?.message, "connection retired");
assert.equal(state.data(), undefined);
dispose();
console.log("PASS SDK Solid loading/error/recovery/invalidation/disposal/remount");
