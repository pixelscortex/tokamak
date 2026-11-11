/** Chat section: the design file's chat view with static sample content. The
 * thread title hangs from the top bar and the composer rises from the bottom,
 * both as shapes of window-base material fused into the shell's layers. */
import { For, Show, createSignal } from "solid-js";
import { Icon, Input } from "@tokamak/ui/elements";
import { Shell, Surface } from "@tokamak/ui/components";
import { stroke } from "./icons";
import { IconButton, SidebarHeader, SidebarLabel, SidebarRow } from "./kit";

/** Responsive layout, in plain CSS layout (no measuring):
 * - The reading column is at most 640 px wide and shrinks with the stage.
 * - The context column (292 px) sits beside it on wide windows. Below a
 *   1200 px window (stage under ~926 px) it gets out of the way, as the
 *   design's collapsible panel; the top bar's panel toggle hides it too.
 * - The title notch and the composer live in the stage's top and bottom
 *   overlays, outside the stage's flow, so they sit in a "lane" with the
 *   same width and centre as the reading column: the stage minus the context
 *   column when that is shown, and 48 px each side: room for the notch's
 *   16 px overhang left of the text, its slant (~16 px) and fillet (14 px),
 *   and for the composer's 22 px fillets, so the fused shapes never reach
 *   the stage's sides. */
const COLUMN = "w-full min-w-0 max-w-[640px]";

/** The lane for content in the stage's overlays (see above). Static class
 * names for Tailwind. */
function lane(context: boolean) {
  return context
    ? "pointer-events-none! flex w-full justify-center px-12 pr-[340px] max-[1200px]:pr-12"
    : "pointer-events-none! flex w-full justify-center px-12";
}

/** The context column: shown when toggled on and the window is wide. */
const CONTEXT_SHOWN = "flex max-[1200px]:hidden";

function ThreadList() {
  const today = [
    { label: "Weekend groceries", meta: "11:40" },
    { label: "Read this lease PDF", meta: "09:12" },
  ];
  const earlier = [
    { label: "Dentist, move to next week", meta: "Sun" },
    { label: "Fastest free model?", meta: "Sat" },
    { label: "Summarise receipts folder", meta: "Nov 4" },
  ];
  return (
    <Shell.Sidebar>
      <SidebarHeader title="Chat" action={stroke.filter} />
      <SidebarLabel first>Today</SidebarLabel>
      <SidebarRow label="Milk, and a Friday nudge" selected dot />
      <For each={today}>{(row) => <SidebarRow label={row.label} meta={row.meta} />}</For>
      <SidebarLabel>Earlier</SidebarLabel>
      <For each={earlier}>{(row) => <SidebarRow label={row.label} meta={row.meta} />}</For>
    </Shell.Sidebar>
  );
}

/** The thread title, hanging from the top bar: base material with 14 px
 * bottom corners and 14 px fillets into the stage's top edge. Its sides lean
 * by `slant` degrees, wider where it meets the top edge: the lean grows
 * outward from the content box (by 40 * tan(slant) px at the top), so it
 * never crowds the text. The title truncates before the notch outgrows the
 * reading column. */
function TitleNotch(props: { slant: number; context: boolean }) {
  return (
    <Shell.TopBar at="stage">
      <div class={lane(props.context)}>
        <div class={`flex ${COLUMN}`}>
          <Surface.Union
            id="lab-chat-notch"
            layer="base"
            radius={[0, 0, 14, 14]}
            join={14}
            slant={props.slant}
            class="pointer-events-auto -ml-4 flex h-10 max-w-full min-w-0 items-center gap-2.5 rounded-b-[14px] bg-base pr-[18px] pb-0.5 pl-4"
          >
            <span
              id="lab-chat-title"
              class="min-w-0 truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink"
            >
              Milk, and a Friday nudge
            </span>
            <span class="size-[3px] shrink-0 rounded-full bg-ink-6" />
            <span class="shrink-0 text-[12px] leading-4 text-ink-4">Today at 14:02</span>
            <span class="flex shrink-0 items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-ink" />
              <span class="text-[12px] leading-4 text-ink-2">Working, 14s</span>
            </span>
          </Surface.Union>
        </div>
      </div>
    </Shell.TopBar>
  );
}

/** The composer, rising from the bottom: base material with 18 px top
 * corners and 22 px fillets into the stage's bottom edge. The surface layer
 * paints below the stage's content, so the composer (and the title notch)
 * also carry an opaque base background over their box: a plate in the
 * bottom bar's own layer, which floats over the scroller, so messages
 * scrolling under them are hidden instead of showing through. */
function Composer(props: { context: boolean }) {
  const [draft, setDraft] = createSignal("");
  return (
    <Shell.BottomBar>
      <div class={lane(props.context)}>
      <Surface.Union
        id="lab-chat-composer-shape"
        layer="base"
        radius={[18, 18, 0, 0]}
        join={22}
        class={`pointer-events-auto flex ${COLUMN} flex-col gap-3.5 rounded-t-[18px] bg-base py-3.5 pr-2.5 pl-4`}
      >
        <div class="relative h-6">
          <Input
            id="lab-chat-composer"
            aria-label="Reply"
            defaultValue=""
            onValueChange={setDraft}
            class="h-6! w-full! rounded-none! border-0! bg-transparent! p-0! text-[15px]! leading-6! text-ink! outline-none!"
          />
          <Show when={draft() === ""}>
            <span class="pointer-events-none absolute top-0 left-0 text-[15px] leading-6 text-ink-4">
              Reply…
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-0.5">
          <div class="-ml-1.5 flex">
            <IconButton d={stroke.paperclip} label="Attach" />
            <IconButton d={stroke.atSign} label="Mention" />
          </div>
          <div class="flex-1" />
          <div class="flex h-7 items-center gap-1 px-2.5">
            <span class="font-data text-[11px] leading-4 text-ink-3">openrouter/free</span>
            <Icon d={stroke.chevronDown} strokeWidth={2} class="size-3 text-ink-4" />
          </div>
          <button
            aria-label="Stop"
            class="flex size-7 items-center justify-center rounded-full border-0 bg-ink p-0"
          >
            <span class="size-[9px] rounded-[2px] bg-[#0a0a0b]" />
          </button>
        </div>
      </Surface.Union>
      </div>
    </Shell.BottomBar>
  );
}

function Messages() {
  return (
    <div id="lab-chat-column" class={`flex ${COLUMN} flex-col pt-5 pb-[180px]`}>
      <div class="h-[52px] shrink-0" />
      <div class="flex justify-end pb-7">
        <Surface id="lab-chat-bubble" material="chip" radius={12} class="max-w-[75%] min-w-0 px-3.5 py-2">
          <p class="m-0 text-[15px] leading-6 tracking-[-0.006em] text-ink">
            Add a todo to buy milk and remind me Friday
          </p>
        </Surface>
      </div>
      <div class="flex h-6 items-center gap-2.5">
        <Icon d={stroke.check} class="size-4 text-ink-4" />
        <span class="text-[13px] leading-4 text-ink-2">Created a task in Todo</span>
        <span class="font-data text-[11px] leading-4 text-ink-5">0.4s</span>
      </div>
      <div class="h-3 shrink-0" />
      <Surface id="lab-chat-card" material="card" radius={10} class="flex flex-col gap-2.5 px-4 pt-3.5 pb-4">
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
          <span class="min-w-0 flex-1 truncate text-[15px] leading-6 font-medium tracking-[-0.006em] text-ink">Buy milk</span>
          <span class="shrink-0 text-[13px] leading-4 text-ink-2">Fri 13 Nov, 09:00</span>
        </div>
      </Surface>
      <div class="h-6 shrink-0" />
      <div id="lab-chat-reply" class="flex flex-col gap-3.5 text-[15px] leading-[26px] tracking-[-0.006em] text-ink-body">
        <p class="m-0">
          Done. <span class="font-semibold text-ink">Buy milk</span> is in your Todo inbox, due Friday
          13 November at 09:00, and I’ll nudge you that morning.
        </p>
        <p class="m-0">
          You also have “Weekend groceries” from this morning with six open items. Want me to fold milk
          into that list instead, so there is one shop to do<span class="text-ink"> ▏</span>
        </p>
      </div>
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
const NOTCH_SLANT = 22;

export default function ChatView() {
  const [context, setContext] = createSignal(true);
  return (
    <>
      <Shell.TopBar at="end">
        <button class="flex h-7 items-center gap-1.5 rounded-sm border-0 bg-transparent px-2.5">
          <Icon d={stroke.squarePen} class="size-4 text-ink-3" />
          <span class="text-[13px] leading-4 font-medium text-ink-2">New chat</span>
        </button>
        <IconButton d={stroke.dots} label="More" />
        <IconButton
          id="lab-chat-context-toggle"
          d={stroke.sidebarRight}
          label="Toggle context"
          active={context()}
          onClick={() => setContext(!context())}
        />
      </Shell.TopBar>
      <ThreadList />
      <TitleNotch slant={NOTCH_SLANT} context={context()} />
      <Shell.Stage>
        <div id="lab-chat" class="flex min-h-full">
          <div class="flex min-w-0 flex-1 flex-col items-center px-12">
            <Messages />
          </div>
          <ContextColumn shown={context()} />
        </div>
      </Shell.Stage>
      <Composer context={context()} />
    </>
  );
}
