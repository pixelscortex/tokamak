import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import type { SignIn, Subscription } from "../src/client/lib/api";
import * as desktop from "../src/client/lib/desktop";
import { Profiles } from "../src/client/pages/profiles";

// The desktop app's return listener on the Profiles page, for every kind of
// waiting sign-in and both companies: the port and path come from each
// company's return address (`lib/companies.ts`), the expected state from the
// sign-in's own link, and a return is finished without anyone pasting it,
// with no dialog open. desktop-sign-in.test.tsx covers the listener's life
// (busy, unavailable, cancel, expiry, replacement) for one Claude sign-in.

vi.mock("../src/client/lib/desktop", () => ({
  hasDesktopSignIn: vi.fn(),
  listenForSignInReturn: vi.fn(),
  cancelSignInReturn: vi.fn(),
  openSignInBrowser: vi.fn(),
}));

type Return = Awaited<ReturnType<typeof desktop.listenForSignInReturn>>;
const team: Subscription = {
  id: "agent-proxy/subscriptions:team",
  company: "anthropic",
  method: "subscription",
  label: "Acme",
  enabled: true,
  plan: "Team",
  status: "ok",
  accounts: [{ id: "agent-proxy/accounts:a1", email: "you@acme.test", status: "ok" }],
  models: [],
  createdAt: 1,
};

let unmount: (() => void) | undefined;
/** The page with `signIns` waiting; `finishSignIn` answers `answer` and empties the list. */
function mount(signIns: SignIn[], answer: Subscription) {
  let listed = { signIns, subscriptions: [team] };
  let publish = () => {};
  const finish = vi.fn(async (_args: JsonValue) => {
    listed = { signIns: [], subscriptions: [team, answer].filter((item, i, all) => all.indexOf(item) === i) };
    publish();
    return answer as unknown as JsonValue;
  });
  const transport: ClientTransport = {
    query: async () => null,
    mutation: async () => null,
    action: async (name, args) => (name.endsWith(":finishSignIn") ? finish(args) : null),
    subscribe(name, _args, onEvent) {
      if (name === "ai-profiles/profiles:list") {
        queueMicrotask(() => onEvent({ value: [] }));
        return () => {};
      }
      publish = () => onEvent({ value: structuredClone(listed) as unknown as JsonValue });
      queueMicrotask(publish);
      return () => {};
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <ClientContext value={new TokamakClient(transport)}>
        <Profiles />
      </ClientContext>
    ),
    root,
  );
  unmount = () => {
    dispose();
    root.remove();
  };
  return { finish };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(desktop.hasDesktopSignIn).mockReturnValue(true);
  vi.mocked(desktop.cancelSignInReturn).mockResolvedValue(undefined);
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
});

test("a ChatGPT sign-in is listened for on 1455 /auth/callback with its own state, and its return finishes it", async () => {
  const address = "http://localhost:1455/auth/callback?code=synthetic&state=gpt-state";
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "returned", address } as Return)
    .mockReturnValue(new Promise<Return>(() => {}));
  const chatgpt: SignIn = {
    id: "agent-proxy/signIns:g1",
    company: "openai",
    method: "subscription",
    link: "https://auth.openai.example/oauth/authorize?state=gpt-state",
    startedAt: Date.now(),
    expired: false,
  };
  const { finish } = mount([chatgpt], { ...team, id: "agent-proxy/subscriptions:gpt", company: "openai" });
  await waitFor(() =>
    expect(desktop.listenForSignInReturn).toHaveBeenCalledWith(
      expect.objectContaining({ port: 1455, path: "/auth/callback", expectedState: "gpt-state" }),
    ),
  );
  await waitFor(() => expect(finish).toHaveBeenCalledWith({ id: chatgpt.id, pasted: address }));
});

test("an add-account sign-in waiting with no dialog open is finished by its return, on its company's port", async () => {
  const address = "http://localhost:54545/callback?code=synthetic&state=add-state";
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "returned", address } as Return)
    .mockReturnValue(new Promise<Return>(() => {}));
  const another: SignIn = {
    id: "agent-proxy/signIns:add1",
    company: "anthropic",
    method: "subscription",
    link: "https://claude.example/oauth/authorize?state=add-state",
    startedAt: Date.now(),
    expired: false,
    addTo: team.id,
  };
  const { finish } = mount([another], team);
  await waitFor(() =>
    expect(desktop.listenForSignInReturn).toHaveBeenCalledWith(
      expect.objectContaining({ port: 54545, path: "/callback", expectedState: "add-state" }),
    ),
  );
  await waitFor(() => expect(finish).toHaveBeenCalledWith({ id: another.id, pasted: address }));
});
