import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { createRoot, createSignal, flush } from "solid-js";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createApi, type FunctionReference, type SubscriptionEvent, type TokamakClient } from "@tokamak/sdk";
import { useQuery } from "@tokamak/sdk/solid";
import { ClientRouter, router } from "../src/router";

const api = createApi<{
  messages: { list: FunctionReference<"query", { threadId: string }, unknown[]> };
}>("chat");

test("query variant changes subscriptions and disposes them", () => {
  const stops = [vi.fn(), vi.fn()];
  const observers: ((event: SubscriptionEvent<unknown>) => void)[] = [];
  const subscribe = vi.fn((_ref, _args, observer) => {
    observers.push(observer);
    return stops[observers.length - 1];
  });
  let dispose!: () => void;
  let update!: () => void;
  createRoot((stop) => {
    dispose = stop;
    const [args, setArgs] = createSignal({ threadId: "threads:a" });
    const query = useQuery({ subscribe } as unknown as TokamakClient, api.messages.list, args);
    flush();
    observers[0]!({ value: [] });
    flush();
    expect(query.data()).toEqual([]);
    expect(query.loading()).toBe(false);
    update = () => setArgs({ threadId: "threads:b" });
  });
  update();
  flush();
  expect(stops[0]).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledTimes(2);
  dispose();
  expect(stops[1]).toHaveBeenCalledOnce();
});

test("an unreachable server gets its own state with a working Retry", async () => {
  const user = userEvent.setup();
  const getEndpoint = vi.fn(() => Promise.reject(new Error("No answer from 127.0.0.1:43123.")));
  const root = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <ClientRouter getEndpoint={getEndpoint} />, root);
  try {
    await router.navigate({ to: "/" });
    const alert = await screen.findByRole("alert", { name: "Server unreachable" });
    expect(alert.textContent).toContain("No answer from 127.0.0.1:43123.");
    expect(screen.getAllByRole("img", { name: "Not connected" })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getEndpoint).toHaveBeenCalledTimes(2));
  } finally {
    dispose();
  }
});

test("the kit route is full-bleed, outside the frame, and closes back to it", async () => {
  const user = userEvent.setup();
  const root = document.body.appendChild(document.createElement("div"));
  const getEndpoint = () => Promise.reject(new Error("offline"));
  const dispose = render(() => <ClientRouter getEndpoint={getEndpoint} />, root);
  try {
    await router.navigate({ to: "/" });
    await screen.findByRole("banner", { name: "Page header" });
    await router.navigate({ to: "/kit" });
    await waitFor(() => expect(screen.getByRole("tablist", { name: "Kit sections" })).toBeTruthy());
    expect(screen.queryByRole("banner", { name: "Page header" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close UI kit" }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.getByRole("banner", { name: "Page header" })).toBeTruthy();
  } finally {
    dispose();
  }
});
