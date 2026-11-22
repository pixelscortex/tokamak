import { expect, expectTypeOf, test, vi } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { Loading, render } from "@solidjs/web";
import {
  createApi,
  TokamakClient,
  type FunctionReference,
  type JsonValue,
  type SubscriptionEvent,
  type User,
} from "../../src/index";
import { ClientContext, useClient, useQuery } from "../../solid";
import { auth } from "../../client";

const api = createApi<{ rows: { list: FunctionReference<"query", { filter: string }, string[]> } }>();
test("queries deliver values and errors, replace arguments, unsubscribe and ignore retired callbacks", () => {
  const observers: ((event: SubscriptionEvent<string[]>) => void)[] = [];
  const stops = [vi.fn(), vi.fn()];
  const subscribe = vi.fn((_reference, _args, observer) => {
    observers.push(observer);
    return stops[observers.length - 1];
  });
  let dispose!: () => void;
  let update!: (args: { filter: string }) => void;
  let state!: ReturnType<typeof useQuery<{ filter: string }, string[]>>;
  createRoot((stop) => {
    dispose = stop;
    const [args, setArgs] = createSignal({ filter: "first" });
    update = setArgs;
    state = useQuery({ subscribe } as unknown as TokamakClient, api.rows.list, args);
  });
  flush();
  expect(state.loading()).toBe(true);
  observers[0]!({ value: ["first"] });
  flush();
  expect(state.data()).toEqual(["first"]);
  expect(state.loading()).toBe(false);
  observers[0]!({ error: new Error("query failed") });
  flush();
  expect(state.error()?.message).toBe("query failed");
  update({ filter: "second" });
  flush();
  expect(stops[0]).toHaveBeenCalledOnce();
  expect(subscribe.mock.calls[1]?.[1]).toEqual({ filter: "second" });
  expect(state.data()).toBeUndefined();
  expect(state.error()).toBeUndefined();
  expect(state.loading()).toBe(true);
  observers[0]!({ value: ["stale"] });
  observers[1]!({ value: ["second"] });
  flush();
  expect(state.data()).toEqual(["second"]);
  dispose();
  expect(stops[1]).toHaveBeenCalledOnce();
  observers[1]!({ value: ["disposed"] });
  expect(state.data()).toEqual(["second"]);
});

test("synchronous subscription errors become query state", () => {
  let state!: ReturnType<typeof useQuery<{ filter: string }, string[]>>;
  const dispose = createRoot((stop) => {
    state = useQuery(
      {
        subscribe: () => {
          throw new Error("closed");
        },
      } as unknown as TokamakClient,
      api.rows.list,
      () => ({ filter: "" }),
    );
    return stop;
  });
  flush();
  expect(state.error()?.message).toBe("closed");
  expect(state.loading()).toBe(false);
  dispose();
});

test("the DOM client context supplies the shell client", () => {
  const client = {} as TokamakClient;
  let received: TokamakClient | undefined;
  function Child() {
    received = useClient();
    return <span>connected</span>;
  }
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ClientContext value={client}>
        <Child />
      </ClientContext>
    ),
    root,
  );
  expect(received).toBe(client);
  expect(root.textContent).toBe("connected");
  dispose();
});

test("auth.me reports the same missing provider error as useClient", () => {
  createRoot((dispose) => {
    try {
      expect(useClient).toThrow("Plugin UI requires the shell client");
      expect(auth.me).toThrow("Plugin UI requires the shell client");
    } finally {
      dispose();
    }
  });
});

test("auth.me renders identity changes in the connected window", () => {
  let receive!: (event: SubscriptionEvent<JsonValue>) => void;
  const stop = vi.fn();
  let subscriptions = 0;
  const client = new TokamakClient({
    query: () => Promise.reject(new Error("auth must stay subscribed")),
    mutation: () => Promise.reject(new Error("unexpected mutation")),
    subscribe(_name, _args, observer) {
      subscriptions++;
      receive = observer;
      return stop;
    },
  });
  function Account() {
    expectTypeOf(auth.me).returns.toHaveProperty("name").toEqualTypeOf<User["name"]>();
    const me = auth.me();
    const device = me.device;
    return (
      <Loading fallback="Loading">
        <span>{`${me.id} · ${me.name} · ${me.role} · ${device.id} · ${device.name}`}</span>
        <span>{` (${auth.me().name})`}</span>
      </Loading>
    );
  }
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ClientContext value={client}>
        <Account />
      </ClientContext>
    ),
    root,
  );
  flush();
  expect(root.textContent).toBe("Loading");
  const device = { id: "device:a", name: "Laptop" };
  receive({ value: { user: { id: "a", name: "Alice", role: "member" }, device } });
  flush();
  expect(root.textContent).toBe("a · Alice · member · device:a · Laptop (Alice)");
  receive({
    value: {
      user: { id: "b", name: "Alicia", role: "admin" },
      device: { id: "device:b", name: "Desktop" },
    },
  });
  flush();
  expect(root.textContent).toBe("b · Alicia · admin · device:b · Desktop (Alicia)");
  expect(subscriptions).toBe(1);
  dispose();
  expect(stop).toHaveBeenCalledOnce();
});
