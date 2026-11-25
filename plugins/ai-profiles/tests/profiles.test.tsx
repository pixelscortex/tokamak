import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import { Profiles } from "../src/client/pages/profiles";

// The Profiles screen with a stand-in server: `list` answers with what
// `listed` holds, and every call the window makes is recorded in `calls`. The
// server side of the same flow runs for real in agent-proxy's sign-in tests.

const LINK = "https://claude.example/oauth/authorize?code=true&state=abc";
const waiting: SignIn = { id: "s1", company: "anthropic", method: "subscription", link: LINK, startedAt: 1 };
const pro: Subscription = {
  id: "sub1",
  company: "anthropic",
  method: "subscription",
  label: "Personal",
  plan: "Pro",
  enabled: true,
  status: "ok",
  accounts: [{ email: "you@example.test", organization: "Fake Org", status: "ok" }],
  models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
  createdAt: 1,
};

let listed: { subscriptions: Subscription[]; signIns: SignIn[] } = { subscriptions: [], signIns: [] };
let answers: Record<string, JsonValue> = {};
const calls: [string, JsonValue][] = [];
const listeners = new Set<() => void>();
const copied: string[] = [];

function client(): TokamakClient {
  const call = async (name: string, args: JsonValue) => {
    calls.push([name, args]);
    return answers[name] ?? null;
  };
  const transport: ClientTransport = {
    query: call,
    mutation: call,
    action: call,
    subscribe(name, _args, onEvent) {
      if (name !== "ai-profiles/subscriptions:list") throw new Error(`Unexpected query ${name}`);
      const send = () => onEvent({ value: structuredClone(listed) as unknown as JsonValue });
      listeners.add(send);
      queueMicrotask(send);
      return () => listeners.delete(send);
    },
  };
  return new TokamakClient(transport);
}

function update(next: typeof listed) {
  listed = next;
  for (const send of listeners) send();
}

const cleanups: (() => void)[] = [];
function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <ClientContext value={client()}>
        <Profiles />
      </ClientContext>
    ),
    root,
  );
  cleanups.push(() => {
    dispose();
    root.remove();
  });
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  listed = { subscriptions: [], signIns: [] };
  answers = {};
  calls.length = 0;
  copied.length = 0;
});

const named = (name: string) => calls.filter(([called]) => called === `ai-profiles/subscriptions:${name}`);

test("the dialog runs company, method, sign-in and connected, and the card shows what was found", async () => {
  const user = userEvent.setup({ document });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  answers["ai-profiles/subscriptions:startSignIn"] = waiting as unknown as JsonValue;
  answers["ai-profiles/subscriptions:finishSignIn"] = pro as unknown as JsonValue;
  mount();
  await user.click(await screen.findByRole("button", { name: "Add subscription" }));

  // Company: Anthropic is the one choice; OpenAI and "More later" are listed, not offered.
  const dialog = await screen.findByRole("dialog", { name: "Add subscription" });
  expect(within(dialog).queryByRole("button", { name: /OpenAI/ })).toBeNull();
  expect(within(dialog).getByText("OpenAI")).toBeTruthy();
  expect(within(dialog).getByText("More later")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: /Anthropic/ }));

  // Method: the API key is shown as coming later and cannot be picked.
  const method = await screen.findByRole("dialog", { name: "Anthropic" });
  expect(within(method).queryByRole("button", { name: /API key/ })).toBeNull();
  expect(within(method).getByText("Later")).toBeTruthy();
  await user.click(within(method).getByRole("button", { name: /Claude subscription/ }));
  expect(named("startSignIn")).toEqual([
    ["ai-profiles/subscriptions:startSignIn", { company: "anthropic", method: "subscription" }],
  ]);

  // Sign-in: the page opens in a new tab, "Copy link" copies the same link, and it says it waits.
  const signIn = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  const open = within(signIn).getByRole("link", { name: "Open sign-in page" });
  expect(open.getAttribute("href")).toBe(LINK);
  expect(open.getAttribute("target")).toBe("_blank");
  await user.click(within(signIn).getByRole("button", { name: "Copy link" }));
  expect(copied).toEqual([LINK]);
  expect(within(signIn).getByText(/Waiting for you to sign in · you can close this/)).toBeTruthy();
  await user.click(within(signIn).getByRole("button", { name: /Signed in on another device/ }));
  await user.type(within(signIn).getByRole("textbox", { name: /Link or code/ }), "the-code#abc");
  await user.click(within(signIn).getByRole("button", { name: "Continue" }));
  expect(named("finishSignIn")).toEqual([
    ["ai-profiles/subscriptions:finishSignIn", { id: "s1", pasted: "the-code#abc" }],
  ]);

  // Connected: plan, email and models found, then a label.
  const connected = await screen.findByRole("dialog", { name: "Connected" });
  expect(within(connected).getByText("Claude Pro")).toBeTruthy();
  expect(within(connected).getByText("you@example.test")).toBeTruthy();
  expect(within(connected).getByText("1 model found")).toBeTruthy();
  expect(
    within(within(connected).getByRole("list", { name: "Models" })).getByText("Sonnet 4.6"),
  ).toBeTruthy();
  const label = within(connected).getByRole("textbox", { name: "Label" });
  await user.clear(label);
  await user.type(label, "Home");
  await user.click(within(connected).getByRole("button", { name: "Done" }));
  expect(named("setLabel")).toEqual([["ai-profiles/subscriptions:setLabel", { id: "sub1", label: "Home" }]]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  update({ subscriptions: [{ ...pro, label: "Home" }], signIns: [] });
  const card = await screen.findByRole("article", { name: "Claude Pro, Home" });
  for (const text of ["you@example.test", "fake org · pro", "OK", "1 model · not used yet"])
    expect(within(card).getByText(text)).toBeTruthy();
  expect(within(card).getByRole("switch", { name: "Claude Pro enabled" })).toBeTruthy();
});

test("a closed dialog leaves an Awaiting sign-in card that reopens it or cancels the sign-in", async () => {
  const user = userEvent.setup({ document });
  listed = { subscriptions: [], signIns: [waiting] };
  mount();
  const card = await screen.findByRole("article", { name: "Claude, awaiting sign-in" });
  await user.click(within(card).getByRole("button", { name: "Continue" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  expect(within(dialog).getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe(LINK);
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Closing stopped nothing.
  expect(named("cancelSignIn")).toEqual([]);

  await user.click(within(card).getByRole("button", { name: "Cancel" }));
  expect(named("cancelSignIn")).toEqual([["ai-profiles/subscriptions:cancelSignIn", { id: "s1" }]]);
});

test("a refused code says why and offers to start again; a signed-out card signs in again in place", async () => {
  const user = userEvent.setup({ document });
  answers["ai-profiles/subscriptions:finishSignIn"] = {
    failed: true,
    kind: "Refused",
    data: { message: "Claude did not accept that code. It may have been used or expired. Start again." },
  };
  answers["ai-profiles/subscriptions:startSignIn"] = {
    ...waiting,
    id: "s2",
    repair: "sub1",
  } as unknown as JsonValue;
  listed = {
    subscriptions: [
      { ...pro, status: "signed-out", reason: "Claude would not renew the login. Sign in again." },
    ],
    signIns: [waiting],
  };
  mount();
  const card = await screen.findByRole("article", { name: "Claude Pro, Personal" });
  expect(within(card).getByText("Signed out")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Continue" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude" });
  await user.click(within(dialog).getByRole("button", { name: /Signed in on another device/ }));
  await user.type(within(dialog).getByRole("textbox", { name: /Link or code/ }), "used-code");
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/did not accept that code/);
  expect(within(dialog).getByRole("button", { name: "Start again" })).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // "Sign in" on the card starts a sign-in that repairs this subscription.
  await user.click(within(card).getByRole("button", { name: "Sign in" }));
  expect(named("startSignIn")).toEqual([
    [
      "ai-profiles/subscriptions:startSignIn",
      { company: "anthropic", method: "subscription", repair: "sub1" },
    ],
  ]);
  expect(await screen.findByRole("dialog", { name: "Sign in to Claude" })).toBeTruthy();
});
