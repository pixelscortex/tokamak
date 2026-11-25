import { screen, waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { afterEach, expect, test } from "vitest";
import { TokamakClient, fail, type ClientTransport, type Id, type JsonValue } from "@tokamak/sdk";
import { ShortcutContext } from "@tokamak/sdk/client";
import { ClientContext } from "@tokamak/sdk/solid";
import type { ComposerProps } from "plugin:chat/client";
import { submitDraft } from "../../chat/src/client/lib/sent";
import { isHeld } from "../../chat/src/client/lib/hold";
import type { Info } from "../src/contracts";
import { refreshAgents } from "../src/client/lib/agents";
import { startTurn } from "../src/client/lib/turn";
import { AgentRow } from "../src/client/ui/agent-row";

// The agent row on its own, with a stand-in client: the Runner answers
// `agents:list` with whatever `installed` holds at that moment, and the server
// answers `choices:get` with `stored` (no turn runs, nothing is queued).

const ready: Info = {
  installed: true,
  signedIn: true,
  install: "",
  signIn: "",
  models: [{ id: "opus", name: "opus 5.5", efforts: [] }],
  speeds: [],
  modes: [],
};
let installed: { id: string; name: string; info: Info }[] = [];
let stored: JsonValue = null;
let creator: JsonValue = { id: "local", name: "Sam" };
let asked = 0;
let hasMachine = true;
let active: JsonValue = null;
let queued: JsonValue = [];
let shortcut: (() => void) | undefined;
const actions: string[] = [];
const threadId = "chat/threads:fixture" as Id<"threads">;
const turnId = "ai/turns:fixture" as Id<"turns">;

function client(): TokamakClient {
  const transport = {
    subscribe: (name: string, _args: JsonValue, onEvent: (event: { value: JsonValue }) => void) => {
      queueMicrotask(() => onEvent({ value: answer(name) }));
      return () => {};
    },
    query: async (name: string) => (name === "ai/turns:pending" ? active : answer(name)),
    mutation: async (name: string) => {
      if (name === "ai/turns:enqueue") return null;
      throw new Error(`Unexpected mutation ${name}`);
    },
    action: async (name: string) => {
      actions.push(name);
      if (!hasMachine) return fail("noMachine", null);
      if (name === "chat/folders:resolve") return "/fixture";
      if (name === "ai/working:list") return [];
      if (name === "ai/run:stop") return null;
      if (name === "ai/run:steer") return { error: null };
      if (name === "ai/run:turn") return { turnId, state: "done" };
      if (name !== "ai/agents:list") throw new Error(`Unexpected action ${name}`);
      asked += 1;
      return structuredClone(installed) as unknown as JsonValue;
    },
  } as unknown as ClientTransport;
  return new TokamakClient(transport, {
    invoke: async (name) => {
      if (name === "chat/folders:resolve") return "/fixture";
      throw new Error(`Unexpected local call ${name}`);
    },
  });
}

/** A picker by its "<name>: <value>" text (jsdom drops the space that browsers keep). */
const picker = (name: string, value = ".+") => new RegExp(`^${name}: ?${value}$`);

/** What the stand-in server answers each live query with. */
function answer(name: string): JsonValue {
  if (name === "ai/choices:get") return stored;
  if (name === "ai/choices:creator") return creator;
  if (name === "ai/turns:ready") return queued;
  if (name === "ai/turns:questions") return [];
  if (name === "ai/turns:active") return active;
  if (name === "auth:caller")
    return {
      user: { id: "local", name: "Sam", role: "owner" },
      device: { id: "here", name: "This computer" },
    };
  throw new Error(`Unexpected query ${name}`);
}

const composer = (threadId: string | undefined) => ({ threadId }) as unknown as ComposerProps;

function mount(threadId: string | undefined, connection = client()) {
  const root = document.createElement("div");
  document.body.append(root);
  const props = {
    ...composer(threadId),
    folder: undefined,
    draft: "",
    sending: false,
    onDraft() {},
    onSend() {},
  };
  const dispose = render(
    () => (
      <ClientContext value={connection}>
        <ShortcutContext
          value={{
            registerShortcut: (_key, run) => {
              shortcut = run;
              return () => {
                shortcut = undefined;
              };
            },
          }}
        >
          <AgentRow {...(props as ComposerProps)} />
        </ShortcutContext>
      </ClientContext>
    ),
    root,
  );
  cleanups.push(() => {
    dispose();
    root.remove();
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  stored = null;
  creator = { id: "local", name: "Sam" };
  asked = 0;
  hasMachine = true;
  active = null;
  queued = [];
  actions.length = 0;
});

test("with one agent, signed out, the agent picker still opens and asks again", async () => {
  installed = [{ id: "solo", name: "Solo", info: { ...ready, signedIn: false } }];
  mount(undefined);
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe("Solo is signed out. Sign in, then come back.");
  expect(isHeld(composer(undefined))).toBe(true);
  expect(screen.queryByRole("button", { name: picker("Model") })).toBeNull();

  // Signing in meanwhile; opening the only picker on screen asks the agent again.
  installed = [{ id: "solo", name: "Solo", info: ready }];
  const before = asked;
  screen.getByRole("button", { name: picker("Agent", "Solo") }).click();
  await waitFor(() => expect(asked).toBeGreaterThan(before));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(isHeld(composer(undefined))).toBe(false);
  expect(screen.getByRole("button", { name: picker("Permission level") })).toBeTruthy();
});

test("a thread whose agent plugin was removed keeps that agent, says it isn't installed and holds Send", async () => {
  installed = [{ id: "solo", name: "Solo", info: ready }];
  stored = { agent: { id: "gone", name: "Gone" }, model: "opus", access: "ask" };
  mount("t1");
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe("Gone isn't installed.");
  expect(screen.getByRole("button", { name: picker("Agent", "Gone") })).toBeTruthy();
  expect(screen.queryByRole("button", { name: picker("Model") })).toBeNull();
  expect(isHeld(composer("t1"))).toBe(true);
  expect(isHeld(composer("t2"))).toBe(false);
});

test("in someone else's thread the row names the creator and hides the agent pickers", async () => {
  installed = [{ id: "solo", name: "Solo", info: ready }];
  stored = { agent: { id: "gone", name: "Gone" }, model: "opus", access: "ask" };
  creator = { id: "morgan", name: "Morgan" };
  mount("t1");
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe("Only Morgan can run the agent here");
  expect(screen.queryByRole("button")).toBeNull();
  // The creator's missing agent does not hold another member's text.
  expect(isHeld(composer("t1"))).toBe(false);
});

const sent = {
  threadId,
  messageId: "chat/messages:fixture" as Id<"messages">,
  text: "Hello",
  first: true,
};

test("no machine is shown only when a Send tries to start a turn", async () => {
  installed = [];
  hasMachine = false;
  const connection = client();
  mount(undefined, connection);
  await refreshAgents(connection);
  await startTurn(connection, { ...sent, folder: undefined });
  await startTurn(connection, { ...sent, folder: "/fixture" });
  expect(screen.queryByRole("status")).toBeNull();
  expect(actions).not.toContain("ai/run:turn");

  installed = [{ id: "solo", name: "Solo", info: ready }];
  hasMachine = true;
  await refreshAgents(connection);
  hasMachine = false;
  await startTurn(connection, { ...sent, folder: "/fixture" });
  expect((await screen.findByRole("status")).textContent).toBe("Connect a machine to run this.");
  expect(actions).toContain("ai/run:turn");
});

test("a transient noMachine leaves Stop and steer usable and retries a ready queue", async () => {
  installed = [{ id: "solo", name: "Solo", info: ready }];
  active = { _id: turnId, threadId, state: "running", sender: { id: "local", device: "here" } };
  queued = [
    {
      _id: "ai/turns:queued",
      threadId: "chat/threads:queued",
      messageId: "queued",
      agent: { id: "solo", name: "Solo" },
    },
  ];
  hasMachine = false;
  const connection = client();
  hasMachine = true;
  await refreshAgents(connection);
  hasMachine = false;
  mount(threadId, connection);
  await waitFor(() => {
    expect(actions).toContain("ai/run:turn");
    expect(shortcut).toBeDefined();
  });
  // Discovery also lost the Runner; it must not disable shortcuts or consume the draft as chat.
  await refreshAgents(connection);
  expect(shortcut).toBeDefined();
  await expect(submitDraft({ threadId, text: "Steer", intent: "steer" })).rejects.toThrow(
    "Connect a machine to run this.",
  );

  hasMachine = true;
  await expect(submitDraft({ threadId, text: "Steer", intent: "steer" })).resolves.toBe(true);
  await waitFor(() => expect(actions.filter((name) => name === "ai/run:turn")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("esc to stop"));
  shortcut?.();
  await waitFor(() => expect(actions).toContain("ai/run:stop"));
});
