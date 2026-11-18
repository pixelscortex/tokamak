import { expect, test, vi } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ExtensionProvider, type ExtensionHost } from "@tokamak/sdk/client";
import {
  ComposerContext,
  composerActions,
  composerAfter,
  composerBefore,
  composerStripLeft,
  composerStripRight,
  createComposerAPI,
  type ComposerSlotProps,
} from "../src/client/lib/composer";
import { useDrafts } from "../src/client/lib/state/use-drafts";
import type { ChatState } from "../src/client/lib/state/use-chat";
import { Composer } from "../src/client/ui/composer/chat-composer";
import { ComposerStrip } from "../src/client/ui/composer/composer-strip";

type Run = { runId: string; threadId: string; waiting: boolean };

function fakeChat(threadId: string) {
  const [runs, setRuns] = createSignal<Record<string, Run>>({}, { ownedWrite: true });
  const [error, setError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [loaded, setLoaded] = createSignal(true, { ownedWrite: true });
  const action = vi.fn(async (_reference: unknown, _args: { threadId: string; text: string }) => ({}));
  const chat = {
    client: { action },
    threadId: () => threadId,
    creating: () => false,
    runs,
    runsLoaded: loaded,
    active: () => runs()[threadId] ?? null,
    setError,
    error,
    backendDiscovery: { refresh: async () => {} },
  } as unknown as ChatState;
  return {
    chat,
    action,
    start: () => setRuns({ [threadId]: { runId: "r", threadId, waiting: false } }),
    finish: () => setRuns({}),
    setLoaded,
  };
}

test("send goes out when idle, queues while a reply runs, and the queue sends when it ends", async () => {
  await createRoot(async (dispose) => {
    const { chat, action, start, finish } = fakeChat("queue-thread");
    const drafts = useDrafts(chat);
    await drafts.send("first");
    expect(action).toHaveBeenLastCalledWith(expect.anything(), { threadId: "queue-thread", text: "first" });

    start();
    flush();
    await drafts.send("follow-up");
    await drafts.send("and this");
    flush();
    expect(action).toHaveBeenCalledTimes(1);
    expect(drafts.queued()).toBe("follow-up\n\nand this");

    finish();
    flush();
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action).toHaveBeenLastCalledWith(expect.anything(), {
      threadId: "queue-thread",
      text: "follow-up\n\nand this",
    });
    flush();
    expect(drafts.queued()).toBe("");
    dispose();
  });
});

test("a failed send puts the text back and reports the reason", async () => {
  await createRoot(async (dispose) => {
    const { chat, action } = fakeChat("fail-thread");
    action.mockRejectedValueOnce(new Error("No agents found"));
    const drafts = useDrafts(chat);
    await drafts.send("hello");
    flush();
    expect(drafts.draft()).toBe("hello");
    expect((chat as unknown as { error: () => string }).error()).toContain("No agents found");
    dispose();
  });
});

test("a send that fails after chat closed still keeps the text for the next visit", async () => {
  let fail = (_cause: Error) => {};
  await createRoot(async (dispose) => {
    const { chat, action } = fakeChat("closed-thread");
    action.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const drafts = useDrafts(chat);
    const sent = drafts.send("keep me");
    dispose();
    fail(new Error("connection lost"));
    await sent;
  });
  await createRoot(async (dispose) => {
    expect(useDrafts(fakeChat("closed-thread").chat).draft()).toBe("keep me");
    dispose();
  });
});

test("a queued follow-up waits until the running list has loaded", async () => {
  await createRoot(async (dispose) => {
    const first = fakeChat("reopen-thread");
    const drafts = useDrafts(first.chat);
    first.start();
    flush();
    await drafts.send("later");
    flush();
    expect(drafts.queued()).toBe("later");
    dispose();
  });
  await createRoot(async (dispose) => {
    // Chat reopens: the running list is empty only because it has not arrived.
    const { chat, action, start, finish, setLoaded } = fakeChat("reopen-thread");
    setLoaded(false);
    const drafts = useDrafts(chat);
    flush();
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    expect(drafts.queued()).toBe("later");
    start();
    setLoaded(true);
    flush();
    expect(action).not.toHaveBeenCalled();
    finish();
    flush();
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    dispose();
  });
});

function host(
  fills: Record<string, (props: ComposerSlotProps) => JSX.Element>,
  targets: Record<string, [string, number]>,
): ExtensionHost {
  return {
    contributions: (kind) =>
      kind === "fill"
        ? Object.entries(targets).map(([id, [target, order]]) => ({
            plugin: "mod",
            id,
            kind: "fill",
            options: { target, order },
          }))
        : [],
    version: () => 1,
    load: async () => fills,
    onError: () => () => {},
  };
}

function mountComposer(options: { busy?: boolean; onStop?: () => void } = {}) {
  const { chat, action, start } = fakeChat(`composer-${Math.random()}`);
  let drafts!: ReturnType<typeof useDrafts>;
  let editor!: ReturnType<typeof createComposerAPI>;
  const fill = (name: string) => () => <span data-testid="fill">{name}</span>;
  const extensions = host(
    {
      Before: fill("before"),
      ActionsLate: fill("actions-late"),
      ActionsEarly: fill("actions-early"),
      Left: fill("left"),
      Right: fill("right"),
      After: fill("after"),
    },
    {
      Before: [composerBefore.name, 0],
      ActionsLate: [composerActions.name, 20],
      ActionsEarly: [composerActions.name, 10],
      Left: [composerStripLeft.name, 0],
      Right: [composerStripRight.name, 0],
      After: [composerAfter.name, 0],
    },
  );
  render(
    () => {
      drafts = useDrafts(chat);
      editor = createComposerAPI(chat, drafts);
      return (
        <ExtensionProvider host={extensions}>
          <ComposerContext value={editor}>
            <Composer
              strip={<ComposerStrip picker={<span>picker</span>} running={Boolean(chat.active())} />}
              placeholder="Ask Claude"
              disabled={false}
              queued={drafts.queued()}
              onUnqueue={() => drafts.unqueue()}
              onEdit={(text) => drafts.edit(text)}
              onStop={options.onStop ?? (() => {})}
            />
          </ComposerContext>
        </ExtensionProvider>
      );
    },
    document.body.appendChild(document.createElement("div")),
  );
  if (options.busy) start();
  return { action, drafts: () => drafts, editor: () => editor };
}

test("the five slots render in their places, in fill order", async () => {
  mountComposer();
  await waitFor(() => expect(screen.getAllByTestId("fill")).toHaveLength(6));
  expect(screen.getAllByTestId("fill").map((node) => node.textContent)).toEqual([
    "before",
    "actions-early",
    "actions-late",
    "left",
    "right",
    "after",
  ]);
});

test("Enter sends, Shift+Enter adds a line, and the send key needs text", async () => {
  const user = userEvent.setup();
  const { action } = mountComposer();
  const input = screen.getByRole("textbox", { name: "Message" });
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  await user.click(input);
  await user.keyboard("first line{Shift>}{Enter}{/Shift}second");
  expect((input as HTMLTextAreaElement).value).toBe("first line\nsecond");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  expect(action.mock.calls[0]![1]).toMatchObject({ text: "first line\nsecond" });
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
});

test("while a reply runs, send becomes stop and typed text queues", async () => {
  const user = userEvent.setup();
  const onStop = vi.fn();
  const { action, drafts } = mountComposer({ busy: true, onStop });
  const stop = await screen.findByRole("button", { name: "Stop" });
  expect(screen.getByText("to stop")).toBeTruthy();
  await user.click(stop);
  expect(onStop).toHaveBeenCalledTimes(1);
  await user.type(screen.getByRole("textbox", { name: "Message" }), "next step");
  await user.click(screen.getByRole("button", { name: "Queue follow-up" }));
  await waitFor(() => expect(screen.getByText("Queued")).toBeTruthy());
  expect(drafts().queued()).toBe("next step");
  expect(action).not.toHaveBeenCalled();
});

test("insertText writes at the caret and keeps the caret after the insert", async () => {
  await createRoot(async (dispose) => {
    const { chat } = fakeChat("insert-thread");
    const drafts = useDrafts(chat);
    const api = createComposerAPI(chat, drafts);
    api.setDraft("run tests");
    api.selection(4, 4);
    api.insertText("the ");
    api.insertText("auth ");
    flush();
    expect(drafts.draft()).toBe("run the auth tests");
    dispose();
  });
});

test("a draft set from code, as a starter does, clears from the box once sent", async () => {
  const user = userEvent.setup();
  const { action, editor } = mountComposer();
  const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  editor().setDraft("Explain how this project is laid out");
  await waitFor(() => expect(input.value).toBe("Explain how this project is laid out"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(input.value).toBe(""));
});
