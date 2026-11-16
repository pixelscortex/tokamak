/** Chat view with sample content and a working composer. */
import { For, createSignal } from "solid-js";
import { Icon } from "@tokamak/ui/elements";
import { Button, Composer, Shell } from "@tokamak/ui/components";
import type { ComposerForm } from "@tokamak/ui/components";
import { stroke } from "./icons";
import * as mocks from "./mocks";

/** Responsive layout, in plain CSS layout (no measuring):
 * - The reading column is at most 640 px wide and shrinks with the stage.
 * - The context column (292 px) sits beside it on wide windows. Below a
 *   1200 px window (stage under ~926 px) it gets out of the way, as the
 *   design's collapsible panel; the top bar's panel toggle hides it too.
 * - The title notch and the composer live in the stage's top and bottom
 *   overlays, outside the stage's flow, so they sit in a "lane" with the
 *   same width and centre as the reading column: the stage minus the context
 *   column when that is shown, with 48 px each side. */
const COLUMN = "w-full min-w-0 max-w-[640px]";

/** The lane for content in the stage's overlays (see above). Static class
 * names for Tailwind. */
function lane(context: boolean) {
  return context
    ? "pointer-events-none! flex min-h-0 w-full justify-center px-12 pr-[340px] max-[1200px]:pr-12"
    : "pointer-events-none! flex min-h-0 w-full justify-center px-12";
}

/** The context column: shown when toggled on and the window is wide. */
const CONTEXT_SHOWN = "flex max-[1200px]:hidden";

/** The thread title in the stage overlay. */
function Title(props: { context: boolean }) {
  return (
    <Shell.TopBar at="stage">
      <div class={lane(props.context)}>
        <div class={`flex ${COLUMN}`}>
          <div
            id="lab-chat-notch"
            class="pointer-events-auto -ml-4 flex h-10 max-w-full min-w-0 items-center gap-2.5 rounded-b-[14px] bg-base pr-[18px] pb-0.5 pl-4"
          >
            <span
              id="lab-chat-title"
              class="min-w-0 truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink"
            >
              {mocks.thread.title}
            </span>
            <span class="size-[3px] shrink-0 rounded-full bg-ink-6" />
            <span class="shrink-0 text-[12px] leading-4 text-ink-4">{mocks.thread.started}</span>
            <span class="flex shrink-0 items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-ink" />
              <span class="text-[12px] leading-4 text-ink-2">{mocks.thread.status}</span>
            </span>
          </div>
        </div>
      </div>
    </Shell.TopBar>
  );
}

/** The composer in the reading column's overlay lane. */
function ChatComposer(props: { context: boolean; send: (text: string) => void }) {
  const [model, setModel] = createSignal("openrouter/free");
  const [chips, setChips] = createSignal(mocks.context.slice(0, 2));
  const [form, setForm] = createSignal(false);
  const [list, setList] = createSignal("inbox");
  const [due, setDue] = createSignal("friday");
  const todoForm = (): ComposerForm => ({
    tag: "/todo",
    placeholder: "Task title",
    fields: mocks.todoFields([list(), setList], [due(), setDue]),
    onSubmit: (title) => {
      setForm(false);
      if (title) props.send(`/todo ${title}`);
    },
    onCancel: () => setForm(false),
  });
  return (
    <Shell.BottomBar>
      <div class={lane(props.context)}>
        <Composer
          id="lab-chat-composer"
          docked
          class={`pointer-events-auto ${COLUMN}`}
          placeholder="Reply…"
          onSubmit={props.send}
          models={mocks.models}
          model={model()}
          onModelChange={setModel}
          context={chips()}
          onRemoveContext={(id) => setChips(chips().filter((c) => c.id !== id))}
          commands={mocks.commands}
          onCommand={(command) => (command.name === "todo" ? setForm(true) : props.send(`/${command.name}`))}
          form={form() ? todoForm() : undefined}
        />
      </div>
    </Shell.BottomBar>
  );
}

/** A message the user sent, on the right. */
function Bubble(props: { id?: string; text: string }) {
  return (
    <div class="flex justify-end pb-7">
      <div id={props.id} class="bg-chip rounded-[12px] max-w-[75%] min-w-0 px-3.5 py-2">
        <p class="m-0 text-[15px] leading-6 tracking-[-0.006em] whitespace-pre-wrap text-ink">{props.text}</p>
      </div>
    </div>
  );
}

function Messages(props: { sent: string[] }) {
  return (
    <div id="lab-chat-column" class={`flex ${COLUMN} flex-col pt-5 pb-[220px]`}>
      <div class="h-[52px] shrink-0" />
      <Bubble id="lab-chat-bubble" text={mocks.thread.ask} />
      <div class="flex h-6 items-center gap-2.5">
        <Icon d={stroke.check} class="size-4 text-ink-4" />
        <span class="text-[13px] leading-4 text-ink-2">{mocks.thread.tool.label}</span>
        <span class="font-data text-[11px] leading-4 text-ink-5">{mocks.thread.tool.time}</span>
      </div>
      <div class="h-3 shrink-0" />
      <div id="lab-chat-card" class="bg-card rounded-[10px] flex flex-col gap-2.5 px-4 pt-3.5 pb-4">
        <div class="flex items-center gap-1.5">
          <span class="text-[12px] leading-4 font-medium text-ink-3">Todo</span>
          <Icon d={stroke.chevronRight} class="size-3 text-ink-5" />
          <span class="text-[12px] leading-4 text-ink-3">Inbox</span>
          <div class="flex-1" />
          <span class="flex items-center gap-1">
            <span class="text-[12px] leading-4 font-medium text-ink-3">Open</span>
            <Icon d={stroke.arrowUpRight} class="size-3 text-ink-3" />
          </span>
        </div>
        <div class="flex items-center gap-3">
          <span class="size-4 shrink-0 rounded-full border-[1.5px] border-solid border-ink-4" />
          <span class="min-w-0 flex-1 truncate text-[15px] leading-6 font-medium tracking-[-0.006em] text-ink">
            {mocks.thread.task.title}
          </span>
          <span class="shrink-0 text-[13px] leading-4 text-ink-2">{mocks.thread.task.due}</span>
        </div>
      </div>
      <div class="h-6 shrink-0" />
      <div
        id="lab-chat-reply"
        class="flex flex-col gap-3.5 text-[15px] leading-[26px] tracking-[-0.006em] text-ink-body"
      >
        <p class="m-0">
          Done. <span class="font-semibold text-ink">{mocks.thread.task.title}</span> {mocks.thread.reply[0]}
        </p>
        <p class="m-0">
          {mocks.thread.reply[1]}
          <span class="text-ink"> ▏</span>
        </p>
      </div>
      <div class="h-7 shrink-0" />
      <For each={props.sent}>{(text, i) => <Bubble id={`lab-chat-sent-${i()}`} text={text} />}</For>
    </div>
  );
}

function ContextColumn(props: { shown: boolean }) {
  const label = "flex h-6 shrink-0 items-center text-[12px] leading-4 font-medium text-ink-4";
  const row = "flex h-7 shrink-0 items-center";
  const key = "w-[88px] shrink-0 text-[13px] leading-4 text-ink-3";
  const value = "font-data text-[11px] leading-4 text-ink";
  return (
    <aside
      id="lab-chat-context"
      class={`${props.shown ? CONTEXT_SHOWN : "hidden"} w-[292px] shrink-0 flex-col gap-8 pt-6 pr-6`}
    >
      <div class="flex flex-col gap-1">
        <div class={label}>Context</div>
        <div class={`${row} gap-2.5`}>
          <Icon d={stroke.squareCheck} class="size-3.5 text-ink-3" />
          <span class="flex-1 text-[13px] leading-4 text-ink">Buy milk</span>
          <span class="text-[12px] leading-4 text-ink-5">Todo</span>
        </div>
        <div class={`${row} gap-2.5`}>
          <Icon d={stroke.message} class="size-3.5 text-ink-3" />
          <span class="flex-1 text-[13px] leading-4 text-ink">Weekend groceries</span>
          <span class="text-[12px] leading-4 text-ink-5">Chat</span>
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <div class={label}>Run</div>
        <div class={row}>
          <span class={key}>Model</span>
          <span class={value}>openrouter/free</span>
        </div>
        <div class={row}>
          <span class={key}>Tokens</span>
          <span class={value}>1,204</span>
        </div>
        <div class={row}>
          <span class={key}>Tools</span>
          <span class={value}>1 call</span>
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <div class={label}>Permissions</div>
        <div class={row}>
          <span class={key}>Todo, write</span>
          <span class="text-[13px] leading-4 text-ink">Always allow</span>
        </div>
      </div>
    </aside>
  );
}

/** The title notch's side lean, degrees from vertical (both sides). */

export default function ChatView() {
  const [context, setContext] = createSignal(true);
  const [sent, setSent] = createSignal<string[]>([]);
  return (
    <>
      <Shell.TopBar at="end">
        <Button variant="ghost" size="sm">
          <Icon d={stroke.squarePen} class="size-4" />
          New chat
        </Button>
        <Button variant="ghost" size="icon" label="More">
          <Icon d={stroke.dots} class="size-4" />
        </Button>
        <Button
          id="lab-chat-context-toggle"
          variant="ghost"
          size="icon"
          label="Toggle context"
          pressed={context()}
          onClick={() => setContext(!context())}
        >
          <Icon d={stroke.sidebarRight} class="size-4" />
        </Button>
      </Shell.TopBar>
      <Title context={context()} />
      <Shell.Stage>
        <div id="lab-chat" class="flex min-h-full">
          <div class="flex min-w-0 flex-1 flex-col items-center px-12">
            <Messages sent={sent()} />
          </div>
          <ContextColumn shown={context()} />
        </div>
      </Shell.Stage>
      <ChatComposer context={context()} send={(text) => setSent([...sent(), text])} />
    </>
  );
}
