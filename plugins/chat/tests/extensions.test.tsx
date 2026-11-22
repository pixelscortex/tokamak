import { screen, waitFor, within } from "@testing-library/dom";
import { createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { expect, test, vi } from "vitest";
import { TokamakClient, type ClientTransport, type Id } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import { ExtensionProvider, RegionOutlet, RegionProvider, ShortcutContext } from "@tokamak/sdk/client";
import { RowList } from "@tokamak/ui";
import { createPluginLoader, type PluginModuleHost } from "../../../packages/runtime/js/plugins";
import {
  Chat,
  Composer,
  Empty,
  Header,
  Message,
  ThreadRow,
  holdSend,
  type MessageDoc,
  type Thread,
} from "../src/client/api";
import { loadActions, manifest } from "virtual:chat-probe";

const threadId = "chat/threads:t1" as Id<"threads">;
const thread = (title: string, id = threadId) =>
  ({ _id: id, _creationTime: 1, title, createdAt: 1, updatedAt: 1 }) as Thread;
const message = (id: string, text: string) =>
  ({
    _id: id,
    _creationTime: 1,
    threadId,
    role: "user",
    author: { id: "local", name: "Sam" },
    parts: [{ type: "text", text }],
    status: "complete",
    createdAt: 1,
  }) as MessageDoc;

/** The real catalog loader with the built probe as the only installed plugin. */
async function probeLoader() {
  const host: PluginModuleHost = {
    importModule: () => loadActions(),
    affected: (names) => new Set(names),
    remove() {},
    evaluate() {
      throw new Error("Expected the ESM loader");
    },
    dependencies: () => [],
    has: () => false,
    require() {
      throw new Error("Expected the ESM loader");
    },
    setLoader() {},
    notifyError() {},
    onError: () => () => {},
  };
  const loader = createPluginLoader(host, {
    plugins: async () => ({ revision: "built", plugins: [manifest] }),
    pluginAsset: async () => {
      throw new Error("Expected the ESM loader");
    },
    onPluginsChanged: () => () => {},
  });
  await loader.connect();
  return loader;
}

/** The element chat publishes as `name`, inside `scope`. */
function part(scope: Element, name: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (!found) throw new Error(`No ${name} part`);
  return found;
}

test("another plugin adds to chat's composer, message, empty thread, list row and header", async () => {
  const loader = await probeLoader();
  const root = document.createElement("div");
  document.body.append(root);
  const first = message("chat/messages:m1", "Add a CSV export");
  const last = message("chat/messages:m2", "Keep the totals exact");
  const dispose = render(
    () => (
      <ClientContext value={new TokamakClient({} as never)}>
        <ExtensionProvider host={loader}>
          <Empty folders={[]} folder={{ kind: "own" }} onFolder={() => {}} />
          <Composer
            threadId={threadId}
            folder={{ kind: "chosen", path: "/code/invoices-app" }}
            draft=""
            sending={false}
            onDraft={() => {}}
            onSend={() => {}}
          />
          <Message message={first} threadId={threadId} next={last} isLast={false} />
          <Message message={last} threadId={threadId} next={undefined} isLast />
          <RowList.Root aria-label="Threads">
            <ThreadRow thread={thread("Add CSV export")} now={1} />
            <ThreadRow thread={thread("Fix rounding", "chat/threads:t2" as Id<"threads">)} now={1} />
          </RowList.Root>
          <Header thread={thread("Add CSV export")} onRename={async () => {}} onDelete={async () => {}} />
        </ExtensionProvider>
      </ClientContext>
    ),
    root,
  );
  try {
    // The empty thread's heading is replaced; its folder choices stay.
    await waitFor(() => screen.getByRole("heading", { name: "What should Probe work on?" }));
    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByRole("radio", { name: "No folder" })).toBeTruthy();

    // Inside the composer's top area, and right after its box.
    expect(within(part(root, "top")).getByText("Probe question")).toBeTruthy();
    expect(part(root, "box").nextElementSibling?.textContent).toBe(`Probe agent row for ${threadId}`);

    // The change card is in the last message's footer only.
    const [early, latest] = screen.getAllByRole("article");
    expect(part(early!, "footer").textContent).toBe("");
    expect(part(latest!, "footer").textContent).toBe(`Probe change card in ${threadId}`);

    // The status lane of every row; the detail line only where `when` matched.
    const [csv, rounding] = screen.getAllByRole("option");
    expect(within(part(csv!, "status")).getByLabelText("Probe status of Add CSV export")).toBeTruthy();
    expect(part(csv!, "detail").textContent).toBe("opus 5.5 · invoices-app");
    expect(part(rounding!, "detail").textContent).toBe("");

    // In the header, right after the title.
    const header = screen.getByRole("heading", { level: 1, name: "Add CSV export" }).closest("[data-part]")!;
    expect(header.nextElementSibling?.textContent).toBe("Probe branch");
  } finally {
    dispose();
    root.remove();
    loader.dispose();
  }
});

function liveChat(initial: MessageDoc[]) {
  let receive!: (rows: MessageDoc[]) => void;
  const publish = (rows: MessageDoc[]) => receive(structuredClone(rows));
  const transport: ClientTransport = {
    query: async () => null,
    mutation: async () => null,
    subscribe(name, _args, onEvent) {
      if (name === "chat/messages:list") {
        receive = (value) => onEvent({ value });
        publish(initial);
      } else {
        onEvent({ value: name === "chat/threads:list" ? [thread("CSV export")] : [] });
      }
      return () => {};
    },
  };
  return { client: new TokamakClient(transport), publish };
}

test("open reply actions stay mounted as chat receives fresh message rows", async () => {
  const first = message("chat/messages:m1", "Export the totals");
  const reply: MessageDoc = {
    ...message("chat/messages:m2", "Working on it"),
    role: "assistant",
    status: "streaming",
  };
  const next = message("chat/messages:m3", "Use CSV");
  const { client, publish } = liveChat([first, reply]);
  const loader = await probeLoader();
  const root = document.createElement("div");
  document.body.append(root);
  const unmounted = vi.fn();
  document.addEventListener("probe-reply-actions-unmounted", unmounted);
  const dispose = render(
    () => (
      <ClientContext value={client}>
        <ShortcutContext value={{ registerShortcut: () => () => {} }}>
          <ExtensionProvider host={loader}>
            <RegionProvider>
              <RegionOutlet name="sidebar" />
              <Chat />
            </RegionProvider>
          </ExtensionProvider>
        </ShortcutContext>
      </ClientContext>
    ),
    root,
  );
  try {
    (await screen.findByRole("option", { name: /CSV export/ })).click();
    const scope = within(await screen.findByRole("log", { name: "Conversation" }));
    const footerActions = await scope.findByRole("button", { name: "Probe footer actions" });
    const bodyActions = scope.getByRole("button", { name: "Probe body actions" });
    expect(footerActions.closest("aside")).not.toBeNull();
    expect(bodyActions.nextElementSibling).toBe(part(bodyActions.closest("article")!, "body"));
    footerActions.click();
    bodyActions.click();
    flush();
    function expectOpen(text: string) {
      expect(scope.getByText(`footer actions for ${text}`)).toBeTruthy();
      expect(scope.getByText(`body actions for ${text}`)).toBeTruthy();
      expect(unmounted).not.toHaveBeenCalled();
    }
    expectOpen("Working on it");

    publish([first, reply, next]);
    flush();
    expect(scope.getByText("Use CSV")).toBeTruthy();
    expect(scope.queryByRole("complementary")).toBeNull();
    expectOpen("Working on it");

    const edited = message("chat/messages:m1", "Export all totals");
    publish([edited, reply, next]);
    flush();
    expect(scope.getByText("Export all totals")).toBeTruthy();
    expectOpen("Working on it");

    const streamed = { ...reply, parts: [{ type: "text" as const, text: "Done" }] };
    publish([edited, streamed, next]);
    flush();
    expectOpen("Done");

    publish([edited, next]);
    flush();
    expect(scope.queryByRole("button", { name: /Probe (body|footer) actions/ })).toBeNull();
    expect(unmounted).toHaveBeenCalledTimes(2);
    expect(unmounted).toHaveBeenCalledWith(expect.objectContaining({ detail: "body" }));
    expect(unmounted).toHaveBeenCalledWith(expect.objectContaining({ detail: "footer" }));
  } finally {
    document.removeEventListener("probe-reply-actions-unmounted", unmounted);
    dispose();
    root.remove();
    loader.dispose();
  }
});

test("another plugin can hold Send in one thread's composer, for the button and for Enter", async () => {
  const loader = await probeLoader();
  const root = document.createElement("div");
  document.body.append(root);
  const sends: string[] = [];
  const [ready, setReady] = createSignal(false, { ownedWrite: true });
  // Held in t1 until `ready`; another thread's composer is never held.
  const stop = holdSend((composer) => composer.threadId === threadId && !ready());
  const other = "chat/threads:t2" as Id<"threads">;
  const dispose = render(
    () => (
      <ClientContext value={new TokamakClient({} as never)}>
        <ExtensionProvider host={loader}>
          {[threadId, other].map((id) => (
            <Composer
              threadId={id}
              folder={undefined}
              draft="Add a CSV export"
              sending={false}
              onDraft={() => {}}
              onSend={() => sends.push(id)}
            />
          ))}
        </ExtensionProvider>
      </ClientContext>
    ),
    root,
  );
  try {
    const [held, free] = await waitFor(() => {
      const buttons = screen.getAllByRole<HTMLButtonElement>("button", { name: "Send" });
      expect(buttons).toHaveLength(2);
      return buttons;
    });
    const [heldInput, freeInput] = screen.getAllByRole("textbox", { name: "Message" });
    expect(held!.disabled).toBe(true);
    expect(free!.disabled).toBe(false);
    for (const input of [heldInput!, freeInput!])
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sends).toEqual([other]);

    // The plugin's own state lets it go: Send works again, live.
    setReady(true);
    flush();
    expect(held!.disabled).toBe(false);
    held!.click();
    expect(sends).toEqual([other, threadId]);

    // A removed hold no longer counts.
    setReady(false);
    flush();
    expect(held!.disabled).toBe(true);
    stop();
    flush();
    expect(held!.disabled).toBe(false);
  } finally {
    stop();
    dispose();
    root.remove();
    loader.dispose();
  }
});
