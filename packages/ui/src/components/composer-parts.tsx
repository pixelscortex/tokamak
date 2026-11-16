import { For, Match, Show, Switch } from "solid-js";
import type { Accessor } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Icon } from "../elements/icon";
import { Button } from "./button";
import { Chip, ChipMore } from "./chip";
import { icons } from "./icons";
import { Select } from "./select";
import type { ComposerProps, ComposerForm, ComposerApproval, ComposerRun } from "./composer-types";

type PartsProps = ComposerProps & { ids: (part: string) => string | undefined };

export function ComposerFormFields(props: PartsProps & { hasShelf: boolean }): JSX.Element {
  const ids = props.ids;
  return (
    <Show when={props.form}>
      {(form: Accessor<ComposerForm>) => (
        <div
          id={ids("form")}
          class={`flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-3 ${props.hasShelf ? "" : "pb-3"}`}
        >
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
  );
}

export function ComposerApprovalShelf(props: PartsProps): JSX.Element {
  const ids = props.ids;
  return (
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
  );
}

export function ComposerRunShelf(props: PartsProps): JSX.Element {
  const ids = props.ids;
  return (
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
                <Button
                  variant="ghost"
                  size="icon"
                  label="Remove queued message"
                  class="size-6"
                  onClick={() => run().onCancelQueued?.()}
                >
                  <Icon d={icons.x} strokeWidth={2} class="size-3" />
                </Button>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

export function ComposerContextChips(props: PartsProps): JSX.Element {
  const ids = props.ids;
  const limit = () => props.contextLimit ?? 6;
  const shown = () => (props.context ?? []).slice(0, limit());
  const hidden = () => Math.max(0, (props.context?.length ?? 0) - limit());
  return (
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
  );
}

export function ComposerFooter(props: PartsProps & { submit: () => void; empty: boolean }): JSX.Element {
  const ids = props.ids;
  const submit = () => props.submit();
  const empty = () => props.empty;
  return (
    <div class="flex shrink-0 items-center gap-0.5 px-2.5 pt-2.5 pb-2.5">
      <Button
        id={ids("attach")}
        variant="ghost"
        size="icon"
        label="Attach"
        onClick={() => props.onAttach?.()}
      >
        <Icon d={icons.paperclip} class="size-4" />
      </Button>
      <Button
        id={ids("mention")}
        variant="ghost"
        size="icon"
        label="Mention"
        onClick={() => props.onMention?.()}
      >
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
          <Button
            id={ids("stop")}
            variant="primary"
            size="icon"
            round
            label="Stop"
            onClick={() => props.onStop?.()}
          >
            <span class="size-[9px] rounded-[2px] bg-base" />
          </Button>
        </Match>
        <Match when={true}>
          <Button
            id={ids("send")}
            variant="primary"
            size="icon"
            round
            label="Send"
            disabled={empty()}
            onClick={submit}
          >
            <Icon d={icons.arrowUp} strokeWidth={2.25} class="size-4" />
          </Button>
        </Match>
      </Switch>
    </div>
  );
}
