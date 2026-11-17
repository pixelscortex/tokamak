import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Avatar, Button, Icon, StatusIcon } from "@tokamak/ui";
import type { Agent } from "../../lib/agents";
import { glyphs } from "../../lib/icons";
import { foldTurn, textOf, timeOfDay, type Message } from "../../lib/turns";
import { Markdown } from "./markdown";
import { PlanList } from "./plan-list";
import { WorkRow } from "./work-row";

function Header(props: { lead: JSX.Element; name: string; fact: string }): JSX.Element {
  return (
    <div class="flex h-6 items-center gap-2">
      {props.lead}
      <span class="text-label text-ink-3">{props.name}</span>
      <span class="text-data text-ink-3">{props.fact}</span>
    </div>
  );
}

const LONG = 600;

export function UserTurn(props: { message: Message }): JSX.Element {
  const text = () => textOf(props.message);
  const long = () => text().length > LONG || text().split("\n").length > 10;
  const [open, setOpen] = createSignal(false);
  return (
    <article aria-label="You" data-role="user" class="flex flex-col gap-2">
      <Header lead={<Avatar name="You" size={16} />} name="You" fact={timeOfDay(props.message.createdAt)} />
      <p
        class={
          long() && !open()
            ? "line-clamp-6 max-w-read text-read break-words whitespace-pre-wrap text-ink"
            : "max-w-read text-read break-words whitespace-pre-wrap text-ink"
        }
      >
        {text()}
      </p>
      <Show when={long()}>
        <button
          type="button"
          class="link self-start rounded-xs text-row focus-ring"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setOpen(!open())}
        >
          {open() ? "Show less" : "Show all"}
        </button>
      </Show>
    </article>
  );
}

export function AgentTurn(props: {
  message: Message;
  agent: Agent | undefined;
  startedAt?: number;
  onRetry?: () => void;
}): JSX.Element {
  const turn = createMemo(() => foldTurn(props.message));
  const name = () => props.agent?.name ?? "Agent";
  return (
    <article
      aria-label={name()}
      data-role="assistant"
      data-status={props.message.status}
      class="flex flex-col gap-4"
    >
      <div class="flex flex-col gap-2">
        <Header
          lead={<Icon path={props.agent?.mark ?? glyphs.chat} class="text-ink" />}
          name={name()}
          fact={timeOfDay(props.message.createdAt)}
        />
        <Show when={turn().texts.length}>
          <div class="flex flex-col gap-3">
            <For each={turn().texts}>{(text) => <Markdown text={text} />}</For>
          </div>
        </Show>
      </div>
      <Show when={turn().work}>{(work) => <WorkRow work={work()} startedAt={props.startedAt} />}</Show>
      <Show when={turn().plan}>
        {(plan) => <PlanList plan={plan()} live={props.message.status === "streaming"} />}
      </Show>
      <Show when={props.message.status === "error"}>
        <div role="alert" class="flex max-w-read items-start gap-2 text-row text-ink-2">
          <span class="flex h-8 items-center">
            <StatusIcon status="failed" />
          </span>
          <span class="min-w-0 flex-1 py-line break-words">
            {props.message.error ?? "The agent could not finish this reply."}
          </span>
          <Show when={props.onRetry}>
            {(retry) => (
              <Button icon={glyphs.retry} onClick={() => retry()()}>
                Retry
              </Button>
            )}
          </Show>
        </div>
      </Show>
      <Show when={props.message.status === "cancelled"}>
        <p class="text-label text-ink-3">Stopped</p>
      </Show>
    </article>
  );
}
