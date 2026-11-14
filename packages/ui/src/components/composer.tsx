/** Composer: the one message input, with the parts that sit around it.
 *
 *   <Shell.BottomBar>
 *     <Composer docked class="w-full max-w-[640px]" placeholder="Reply…"
 *       models={models} model={model()} onModelChange={setModel}
 *       onSubmit={send} />
 *   </Shell.BottomBar>
 *
 * The composer owns the text; everything else comes in through props, so a
 * plugin can supply content without owning the input. Its states:
 *
 * - idle: placeholder, a footer with attach and mention buttons, the model
 *   `Select` (compact, opening upward) and the send button (dim until
 *   there is text). Enter sends, Shift+Enter adds a line.
 * - `context`: chips above the text, two rows at most; past
 *   `contextLimit` chips the rest is one "+N more" chip.
 * - `running`: a status shelf above the text (step, step count, elapsed
 *   time, an optional queued follow-up); send becomes stop (`onStop`).
 *   Enter still calls `onSubmit` (the owner queues it).
 * - `commands`: typing `/` at the start lists the commands whose name
 *   starts with what follows, above the text: six rows, then it scrolls,
 *   with a row of key hints. Up and Down move, Enter or Tab picks
 *   (`onCommand`, and the text is cleared), Escape closes it.
 * - `form`: a picked command, as its tag with its option selects above the
 *   text; the text is the form's title and send becomes `submitLabel`
 *   (Create). Enter submits too.
 * - `approval`: a question with Deny, Allow once and (optional) Always
 *   allow above the text.
 * - `above` and `tools`: free slots above the text and in the footer.
 *
 * What sits above the message is separated from it by a faint divider;
 * the composer is one shape that grows taller. `docked` makes that shape
 * rise out of the window base (a `Surface.Add` of the base layer, with
 * fillets into the stage's bottom edge); put it in `Shell.BottomBar`.
 * Otherwise it is a free base-coloured plate (galleries).
 *
 * Height: the shell's bottom bar is at most 60% of the stage, and the
 * composer fills what it gets: the text gives up its lines first (it
 * shrinks a thousand times faster), then the part above the divider
 * scrolls.
 *
 * Ids, from `id`: `-input` (the textarea), `-send`, `-stop`, `-submit`,
 * `-model`, `-attach`, `-mention`, `-chip-<i>`, `-more`, `-status`,
 * `-queued`, `-commands`, `-command-<i>`, `-form`, `-deny`, `-allow`,
 * `-always`. */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import type { JSX } from "@tokamak/render";
import type { NativeEvent } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { Button } from "./button";
import { Chip, ChipMore } from "./chip";
import { icons } from "./icons";
import { Kbd } from "./kbd";
import { Select } from "./select";
import type { SelectOption } from "./select";
import { Surface } from "./surface";
import { Textarea } from "./textarea";

/** A context chip: what the message is about (a task, a file). */
export interface ComposerContext {
  id: string;
  label: string;
  /** Where it comes from (a plugin, a folder). */
  detail?: string;
  /** Leading icon path data (24 px viewBox, stroked). */
  icon?: string;
}

/** The run in progress, for the status shelf. */
export interface ComposerRun {
  /** What the run is doing now. */
  step: string;
  /** 1-based number of the current step. */
  stepIndex: number;
  stepCount: number;
  /** Elapsed time, already formatted ("14s", "1:05"). */
  elapsed: string;
  /** A follow-up typed while running, sent when the run ends. */
  queued?: string;
  onCancelQueued?: () => void;
}

/** A command a plugin offers. */
export interface ComposerCommand {
  /** Without the slash: `todo`. */
  name: string;
  description: string;
  /** The plugin that offers it. */
  source: string;
}

/** One option select of a command form. */
export interface ComposerField {
  id: string;
  /** Accessible name (the select shows only the value). */
  label: string;
  options: readonly SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
}

/** A picked command waiting for its title and options. */
export interface ComposerForm {
  /** The command's tag: `/todo`. */
  tag: string;
  /** Placeholder of the title (the composer's text). */
  placeholder?: string;
  fields?: readonly ComposerField[];
  /** The submit button's label (default "Create"). */
  submitLabel?: string;
  onSubmit: (title: string) => void;
  onCancel?: () => void;
}

/** A question the run asks before it goes on. */
export interface ComposerApproval {
  question: string;
  /** What is asked for, in the data font (`todo.write`). */
  detail?: string;
  onDeny: () => void;
  onAllowOnce: () => void;
  /** Shows "Always allow". */
  onAlwaysAllow?: () => void;
}

export interface ComposerProps {
  id?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** Enter or the send button, with the text (trimmed text is not empty).
   * The composer clears its text afterwards. */
  onSubmit?: (text: string) => void;
  /** Lines of text before it scrolls (default 8). */
  maxRows?: number;
  docked?: boolean;
  /** Classes of the outer shape (width). */
  class?: string;
  context?: readonly ComposerContext[];
  /** Chips shown before "+N more" (default 6). */
  contextLimit?: number;
  onRemoveContext?: (id: string) => void;
  models?: readonly SelectOption[];
  model?: string;
  onModelChange?: (value: string) => void;
  onAttach?: () => void;
  onMention?: () => void;
  running?: ComposerRun;
  onStop?: () => void;
  commands?: readonly ComposerCommand[];
  onCommand?: (command: ComposerCommand) => void;
  form?: ComposerForm;
  approval?: ComposerApproval;
  /** Free content above the text (below the states above). */
  above?: JSX.Element;
  /** Extra footer content, after attach and mention. */
  tools?: JSX.Element;
}

/** Rows of the command list before it scrolls, and their height. */
const COMMAND_ROWS = 6;
const COMMAND_ROW = 30;

export function Composer(props: ComposerProps): JSX.Element {
  const [own, setOwn] = createSignal(untrack(() => props.defaultValue ?? ""));
  const draft = () => props.value ?? own();
  function setDraft(next: string) {
    if (props.value === undefined) setOwn(next);
    props.onValueChange?.(next);
  }
  const ids = (part: string) => (props.id ? `${props.id}-${part}` : undefined);
  const empty = () => draft().trim() === "";

  // Commands: `/` at the start, then the name typed so far.
  const [closed, setClosed] = createSignal(false);
  createEffect(on(draft, () => setClosed(false), { defer: true }));
  const matches = createMemo(() => {
    const m = /^\/(\S*)$/.exec(draft());
    if (!m || !props.commands?.length || props.form) return [];
    const q = m[1].toLowerCase();
    return props.commands.filter((c) => c.name.toLowerCase().startsWith(q));
  });
  const listing = () => !closed() && matches().length > 0;
  const [active, setActive] = createSignal(0);
  createEffect(on(matches, () => setActive(0)));

  function pickCommand(command: ComposerCommand) {
    setDraft("");
    props.onCommand?.(command);
  }
  function submit() {
    const text = draft();
    if (props.form) {
      props.form.onSubmit(text.trim());
      setDraft("");
      return;
    }
    if (text.trim() === "") return;
    props.onSubmit?.(text);
    setDraft("");
  }
  function keydown(event: NativeEvent) {
    if (!listing() || event.isComposing) return;
    const n = matches().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((active() + (event.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      if (!event.repeat) pickCommand(matches()[active()]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setClosed(true);
    }
  }

  const limit = () => props.contextLimit ?? 6;
  const shown = () => (props.context ?? []).slice(0, limit());
  const hidden = () => Math.max(0, (props.context?.length ?? 0) - limit());
  const hasAbove = () =>
    Boolean(props.approval || props.running || listing() || props.form || props.context?.length || props.above);

  const body = () => (
    <>
      <Show when={hasAbove()}>
        {/* Above the message: scrolls when the composer runs out of room
          * and the text has given up its lines. */}
        <div class="flex min-h-0 shrink flex-col gap-3 overflow-y-auto px-4 pt-3 pb-3">
          <Show when={props.approval}>
            {(approval: Accessor<ComposerApproval>) => (
              <div class="flex flex-col gap-2.5">
                <div class="flex items-start gap-2.5">
                  <Icon d={icons.shield} class="mt-0.5 size-4 shrink-0 text-ink-3" />
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <p class="m-0 text-[13px] leading-5 text-ink">{approval().question}</p>
                    <Show when={approval().detail}>
                      <span class="font-data text-[11px] leading-4 text-ink-4">{approval().detail}</span>
                    </Show>
                  </div>
                </div>
                <div class="flex items-center justify-end gap-1.5">
                  <Button id={ids("deny")} variant="outline" size="sm" onClick={() => approval().onDeny()}>
                    Deny
                  </Button>
                  <Show when={approval().onAlwaysAllow}>
                    <Button id={ids("always")} size="sm" onClick={() => approval().onAlwaysAllow?.()}>
                      Always allow
                    </Button>
                  </Show>
                  <Button id={ids("allow")} variant="primary" size="sm" onClick={() => approval().onAllowOnce()}>
                    Allow once
                  </Button>
                </div>
              </div>
            )}
          </Show>
          <Show when={props.running}>
            {(run: Accessor<ComposerRun>) => (
              <div id={ids("status")} class="flex flex-col gap-1.5">
                <div class="flex h-5 items-center gap-2.5">
                  <span class="size-1.5 shrink-0 rounded-full bg-ink" />
                  <span class="min-w-0 flex-1 truncate text-[13px] leading-4 text-ink-2">{run().step}</span>
                  <span class="shrink-0 font-data text-[11px] leading-4 text-ink-4">
                    {run().stepIndex}/{run().stepCount}
                  </span>
                  <span class="shrink-0 font-data text-[11px] leading-4 text-ink-3">{run().elapsed}</span>
                </div>
                <Show when={run().queued}>
                  <div id={ids("queued")} class="flex h-6 items-center gap-2.5">
                    <Icon d={icons.corner} class="size-3.5 shrink-0 text-ink-4" />
                    <span class="shrink-0 font-data text-[11px] leading-4 text-ink-4">QUEUED</span>
                    <span class="min-w-0 flex-1 truncate text-[13px] leading-4 text-ink-2">{run().queued}</span>
                    <Show when={run().onCancelQueued}>
                      <Button variant="ghost" size="icon" label="Remove queued message" class="size-6" onClick={() => run().onCancelQueued?.()}>
                        <Icon d={icons.x} strokeWidth={2} class="size-3" />
                      </Button>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={listing()}>
            <div class="flex flex-col gap-1.5">
              <div
                id={ids("commands")}
                role="listbox"
                class="-mx-2 flex flex-col overflow-y-auto overscroll-contain"
                style={`max-height: ${COMMAND_ROWS * COMMAND_ROW}px`}
              >
                <For each={matches()}>
                  {(command, i) => (
                    <div
                      role="option"
                      id={ids(`command-${i()}`)}
                      data-active={active() === i() ? "" : undefined}
                      aria-selected={active() === i()}
                      onClick={() => pickCommand(command)}
                      class="flex shrink-0 items-center gap-3 rounded-md px-2 hover:bg-chip data-active:bg-chip"
                      style={`height: ${COMMAND_ROW}px`}
                    >
                      <span class="w-24 shrink-0 truncate text-[13px] leading-4 font-medium text-ink">/{command.name}</span>
                      <span class="min-w-0 flex-1 truncate text-[13px] leading-4 text-ink-3">{command.description}</span>
                      <span class="shrink-0 font-data text-[11px] leading-4 text-ink-5">{command.source}</span>
                    </div>
                  )}
                </For>
              </div>
              <div class="flex h-5 items-center gap-1.5 text-[12px] leading-4 text-ink-4">
                <Kbd keys={["up"]} />
                <Kbd keys={["down"]} />
                <span class="mr-2">to move</span>
                <Kbd keys={["enter"]} />
                <span class="mr-2">to pick</span>
                <Kbd keys={["esc"]} />
                <span>to close</span>
              </div>
            </div>
          </Show>
          <Show when={props.form}>
            {(form: Accessor<ComposerForm>) => (
              <div id={ids("form")} class="flex flex-wrap items-center gap-1.5">
                <span class="flex h-[26px] items-center gap-1 rounded-sm bg-chip pr-0.5 pl-2 text-[13px] leading-4 font-medium text-ink">
                  {form().tag}
                  <Show when={form().onCancel}>
                    <button
                      type="button"
                      aria-label="Cancel command"
                      onClick={() => form().onCancel?.()}
                      class="flex size-5 items-center justify-center rounded-xs border-0 bg-transparent p-0 text-ink-4 hover:bg-lift hover:text-ink"
                    >
                      <Icon d={icons.x} strokeWidth={2} class="size-3" />
                    </button>
                  </Show>
                </span>
                <For each={form().fields ?? []}>
                  {(field) => (
                    <Select
                      id={ids(`field-${field.id}`)}
                      label={field.label}
                      size="compact"
                      side="top"
                      options={field.options}
                      value={field.value}
                      onValueChange={(v) => field.onChange?.(v)}
                    />
                  )}
                </For>
              </div>
            )}
          </Show>
          <Show when={props.context?.length}>
            {/* Two rows at most (24 px chips, 6 px gap). */}
            <div class="flex max-h-[54px] flex-wrap gap-1.5 overflow-hidden">
              <For each={shown()}>
                {(chip, i) => (
                  <Chip
                    id={ids(`chip-${i()}`)}
                    label={chip.label}
                    detail={chip.detail}
                    icon={chip.icon}
                    onRemove={props.onRemoveContext ? () => props.onRemoveContext?.(chip.id) : undefined}
                  />
                )}
              </For>
              <Show when={hidden() > 0}>
                <ChipMore id={ids("more")} count={hidden()} />
              </Show>
            </div>
          </Show>
          {props.above}
        </div>
        <div class="mx-4 h-px shrink-0 bg-line" />
      </Show>
      {/* The message: gives up lines first when room runs out. */}
      <div class={`flex min-h-6 shrink-[1000] flex-col px-4 ${hasAbove() ? "pt-3" : "pt-3.5"}`}>
        <Textarea
          id={ids("input")}
          aria-label="Message"
          placeholder={props.form?.placeholder ?? props.placeholder}
          maxRows={props.maxRows}
          value={draft()}
          onValueChange={setDraft}
          onKeyDown={keydown}
          onSubmit={submit}
          class="min-h-0 flex-auto"
        />
      </div>
      <div class="flex shrink-0 items-center gap-0.5 px-2.5 pt-2.5 pb-2.5">
        <Button id={ids("attach")} variant="ghost" size="icon" label="Attach" onClick={() => props.onAttach?.()}>
          <Icon d={icons.paperclip} class="size-4" />
        </Button>
        <Button id={ids("mention")} variant="ghost" size="icon" label="Mention" onClick={() => props.onMention?.()}>
          <Icon d={icons.atSign} class="size-4" />
        </Button>
        {props.tools}
        <div class="flex-1" />
        <Show when={!props.form && props.models?.length}>
          <Select
            id={ids("model")}
            label="Model"
            size="compact"
            side="top"
            align="end"
            mono
            search={(props.models?.length ?? 0) > 6}
            options={props.models ?? []}
            value={props.model}
            onValueChange={(v) => props.onModelChange?.(v)}
            class="mr-1"
          />
        </Show>
        <Switch>
          <Match when={props.form}>
            {(form: Accessor<ComposerForm>) => (
              <Button id={ids("submit")} variant="primary" size="sm" onClick={submit}>
                {form().submitLabel ?? "Create"}
              </Button>
            )}
          </Match>
          <Match when={props.running}>
            <Button id={ids("stop")} variant="primary" size="icon" round label="Stop" onClick={() => props.onStop?.()}>
              <span class="size-[9px] rounded-[2px] bg-base" />
            </Button>
          </Match>
          <Match when={true}>
            <Button id={ids("send")} variant="primary" size="icon" round label="Send" disabled={empty()} onClick={submit}>
              <Icon d={icons.arrowUp} strokeWidth={2.25} class="size-4" />
            </Button>
          </Match>
        </Switch>
      </div>
    </>
  );

  const frame = "flex min-h-0 flex-col font-ui";
  return (
    <Show
      when={props.docked}
      fallback={
        <div id={props.id} class={`${frame} rounded-[18px] bg-base ${props.class ?? ""}`}>
          {body()}
        </div>
      }
    >
      <Surface.Add
        id={props.id}
        layer="base"
        join={22}
        class={`${frame} pointer-events-auto rounded-t-[18px] bg-base ${props.class ?? ""}`}
      >
        {body()}
      </Surface.Add>
    </Show>
  );
}
