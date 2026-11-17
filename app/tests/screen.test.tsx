import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { createRoot, createSignal, flush } from "solid-js";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { Controls } from "../src/controls";
import { App } from "../src/app";
import { useQuery } from "@tokamak/sdk/solid";
import { api } from "../src/api";
import { ClientRouter, router } from "../src/router";
import type { TokamakClient, SubscriptionEvent } from "@tokamak/sdk";

test("keyboard opens, navigates, selects, and Escape restores focus", async () => {
  const user = userEvent.setup();
  const root = document.body.appendChild(document.createElement("div"));
  const create = vi.fn();
  const dispose = render(() => <Controls onNew={create} onDisconnect={() => {}} />, root);
  try {
    const trigger = screen.getByRole("button", { name: "Thread actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("Disconnect");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const about = screen.getByRole("button", { name: "About Tokamak" });
    about.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Tokamak" })).toBeTruthy());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(about));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(document.activeElement).toBe(about));
    const select = screen.getByRole("combobox", { name: "Density preview" });
    select.focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    await waitFor(() => expect(select.textContent).toContain("Compact"));
    await user.keyboard("{Enter}{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(select));
  } finally {
    dispose();
  }
});

test("whole screen names controls and reports disconnected state", () => {
  const root = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <App />, root);
  try {
    expect(screen.getByRole("textbox", { name: "Server WebSocket" })).toBeTruthy();
    for (const name of ["Connect", "Thread actions", "About Tokamak", "Connection help"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Connection status" }).textContent).toBe("Disconnected");
  } finally {
    dispose();
  }
});

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
    const [args, setArgs] = createSignal({ threadId: "threads:a" as never });
    const query = useQuery({ subscribe } as unknown as TokamakClient, api.messages.list, args);
    flush();
    observers[0]!({ value: [] });
    flush();
    expect(query.data()).toEqual([]);
    expect(query.loading()).toBe(false);
    update = () => setArgs({ threadId: "threads:b" as never });
  });
  update();
  flush();
  expect(stops[0]).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledTimes(2);
  dispose();
  expect(stops[1]).toHaveBeenCalledOnce();
});

test("TanStack Solid routes render kit and return to threads on Solid 2", async () => {
  const root = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <ClientRouter />, root);
  try {
    await router.navigate({ to: "/kit" });
    await waitFor(() => expect(screen.getByRole("tablist", { name: "Kit sections" })).toBeTruthy());
    expect(window.location.pathname).toBe("/kit");
    await router.navigate({ to: "/" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Server WebSocket" })).toBeTruthy());
    expect(window.location.pathname).toBe("/");
  } finally {
    dispose();
  }
});
