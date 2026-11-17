import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { view, Region, usePageTitle, useShortcuts } from "@tokamak/sdk/client";
import { useClient, useQuery } from "@tokamak/sdk/solid";
import type { Id } from "@tokamak/sdk";
import { useRouter } from "@tokamak/runtime/router";
import { Button, StatusIcon, icons } from "@tokamak/ui";
import { ComposerContext, createComposerAPI, type EditorAPI } from "../lib/composer";
import { chatIcon } from "../lib/icons";
import { chatKeys } from "../lib/state/chat-keys";
import { api, useChat, type ChatState } from "../lib/state/use-chat";
import { useDrafts } from "../lib/state/use-drafts";
import { lastReply, pendingPermission, permissionOptions, promptBefore, type Message } from "../lib/turns";
import { AgentPicker } from "../ui/composer/agent-picker";
import { Composer } from "../ui/composer/chat-composer";
import { ComposerStrip } from "../ui/composer/composer-strip";
import { NeedsYou } from "../ui/composer/needs-you";
import { ThreadHeader } from "../ui/header/thread-header";
import { ThreadList } from "../ui/sidebar/thread-list";
import { EmptyThread, NoAgents } from "../ui/thread/empty";
import { ThreadView } from "../ui/thread/thread-view";

export const Chat = view({ route: "/", icon: chatIcon }, () => {
  const client = useClient();
  const router = useRouter();
  const shortcuts = useShortcuts();
  const chat = useChat(client);
  const drafts = useDrafts(chat);
  const editor = createComposerAPI(chat, drafts);
  usePageTitle(() => chat.thread()?.title);
  const [pickerOpen, setPickerOpen] = createSignal(false, { ownedWrite: true });
  const [note, setNote] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  let latest: readonly Message[] = [];
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(noteTimer));

  async function newThread() {
    if (!(await chat.createThread())) return;
    if (!router.location().pathname.startsWith("/p/chat")) router.navigate("/p/chat");
    requestAnimationFrame(() => editor.focus());
  }

  async function copyReply() {
    const text = lastReply(latest);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      clearTimeout(noteTimer);
      setNote("Copied");
      noteTimer = setTimeout(() => setNote(undefined), 1500);
    } catch (cause) {
      chat.setError(`Copy failed: ${String(cause)}`);
    }
  }

  onCleanup(shortcuts.registerShortcut("Meta+n", () => void newThread()));
  onCleanup(shortcuts.registerShortcut("Meta+Shift+c", () => void copyReply()));
  onCleanup(shortcuts.registerShortcut("Meta+m", () => setPickerOpen((open) => !open)));

  return (
    <ComposerContext value={editor}>
      <Region.Sidebar>
        <ThreadList chat={chat} onNew={() => void newThread()} />
      </Region.Sidebar>
      <Region.Header>
        <ThreadHeader chat={chat} onCopy={() => void copyReply()} />
      </Region.Header>
      <section aria-label="Chat" data-thread-id={chat.threadId()} class="flex h-full min-h-0 flex-1 flex-col">
        <Show
          keyed
          when={chat.threadId()}
          fallback={
            <Show when={chat.noAgents()}>
              <NoAgentsHere chat={chat} />
            </Show>
          }
        >
          {(threadId: Id<"threads">) => (
            <ThreadPane
              chat={chat}
              drafts={drafts}
              editor={editor}
              threadId={threadId}
              note={note()}
              pickerOpen={pickerOpen()}
              onPickerOpen={setPickerOpen}
              onMessages={(messages) => {
                latest = messages;
              }}
            />
          )}
        </Show>
      </section>
    </ComposerContext>
  );
});

function NoAgentsHere(props: { chat: ChatState }): JSX.Element {
  return (
    <NoAgents
      checking={props.chat.backendDiscovery.loading()}
      error={props.chat.backendDiscovery.error()}
      onCheck={() => void props.chat.backendDiscovery.refresh()}
    />
  );
}

function ThreadPane(props: {
  chat: ChatState;
  drafts: ReturnType<typeof useDrafts>;
  editor: EditorAPI;
  threadId: Id<"threads">;
  note: string | undefined;
  pickerOpen: boolean;
  onPickerOpen: (open: boolean) => void;
  onMessages: (messages: readonly Message[]) => void;
}): JSX.Element {
  const { chat, drafts, editor } = props;
  const messages = useQuery(chat.client, api.messages.list, () => ({ threadId: props.threadId }));
  const run = useQuery(chat.client, api.runs.active, () => ({ threadId: props.threadId }));
  const [answering, setAnswering] = createSignal(false, { ownedWrite: true });
  const list = () => messages.data() ?? [];
  createEffect(list, (value) => {
    props.onMessages(value);
  });
  const pending = () => pendingPermission(messages.data());
  const running = () => Boolean(chat.active());
  const agentName = () => chat.agent()?.name ?? "the agent";

  async function answer(optionId: string) {
    const current = pending();
    if (!current || answering()) return;
    setAnswering(true);
    try {
      await chat.client.mutation(api.permissions.answer, {
        messageId: current.messageId,
        requestId: current.part.requestId,
        optionId,
      });
    } catch (cause) {
      chat.setError(String(cause));
    } finally {
      setAnswering(false);
    }
  }

  const keys = chatKeys({
    draft: () => editor.getDraft(),
    canStop: chat.canStop,
    stop: () => void chat.cancel(),
    answer(index) {
      const current = pending();
      const option = current && permissionOptions(current.part)[index];
      if (!option) return false;
      void answer(option.optionId);
      return true;
    },
  });

  const placeholder = () =>
    chat.noAgents()
      ? "No agents found"
      : pending()
        ? `Or tell ${agentName()} what to do instead`
        : running()
          ? "Queue a follow-up"
          : `Ask ${agentName()}`;

  return (
    <div class="flex min-h-0 flex-1 flex-col" onKeyDown={keys}>
      <ThreadView
        messages={list()}
        agent={chat.agent()}
        run={run.data() ? { messageId: run.data()!.messageId, startedAt: run.data()!.startedAt } : undefined}
        canRetry={!running() && !chat.noAgents()}
        onRetry={(id) => {
          const text = promptBefore(list(), id);
          if (text) void drafts.send(text);
        }}
        empty={
          <Show when={!messages.loading()}>
            <Show
              when={chat.noAgents() || chat.backendDiscovery.error()}
              fallback={
                <EmptyThread
                  agent={chat.agent()}
                  onStart={(text) => {
                    editor.setDraft(text);
                    editor.focus();
                  }}
                />
              }
            >
              <NoAgentsHere chat={chat} />
            </Show>
          </Show>
        }
      />
      <div class="flex shrink-0 justify-center px-6 pb-4">
        <div class="flex w-full max-w-thread flex-col gap-2">
          <Show when={chat.error() ?? messages.error()?.message}>
            {(error) => (
              <div role="alert" class="flex items-center gap-2 ps-1 text-row text-ink-2">
                <StatusIcon status="failed" />
                <span class="min-w-0 flex-1 break-words">{error()}</span>
                <Button
                  variant="ghost"
                  icon={icons.close}
                  label="Dismiss"
                  onClick={() => chat.setError(undefined)}
                />
              </div>
            )}
          </Show>
          <Show when={!chat.noAgents()}>
            <Composer
              band={
                <Show when={pending()}>
                  {(current) => (
                    <NeedsYou
                      part={current().part}
                      agentName={agentName()}
                      busy={answering()}
                      onAnswer={(optionId) => void answer(optionId)}
                    />
          </Show>
                )}
              </Show>
            }
            strip={
              <ComposerStrip
                running={running()}
                note={props.note ?? (drafts.raced() ? "A reply is already running" : undefined)}
                picker={
                  <Show when={!chat.noAgents()}>
                    <AgentPicker chat={chat} open={props.pickerOpen} onOpenChange={props.onPickerOpen} />
                  </Show>
                }
              />
            }
            placeholder={placeholder()}
            disabled={Boolean(chat.noAgents())}
            queued={drafts.queued()}
            onUnqueue={() => drafts.unqueue()}
            onEdit={(text) => {
              drafts.edit(text);
              drafts.clearRace();
            }}
            onStop={() => void chat.cancel()}
          />
        </div>
      </div>
    </div>
  );
}
