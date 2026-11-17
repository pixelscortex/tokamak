import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Collapsible, Icon, StatusIcon, type Status } from "@tokamak/ui";
import { glyphs } from "../../lib/icons";
import { clock, plural, type Step, type Work } from "../../lib/turns";

/** A clock that ticks once a second while it is mounted. */
export function useNow(): () => number {
  const [now, setNow] = createSignal(Date.now(), { ownedWrite: true });
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  return now;
}

function workStatus(work: Work): Status {
  if (work.running) return "running";
  return work.failed ? "failed" : "done";
}

/** All tool work of one turn as one row: the latest step and a timer while running, a summary when done. */
export function WorkRow(props: { work: Work; startedAt?: number }): JSX.Element {
  return (
    <Collapsible.Root class="flex flex-col">
      <Collapsible.Trigger
        lead={
          <Show when={props.work.waiting} fallback={<StatusIcon status={workStatus(props.work)} />}>
            <Icon path={glyphs.lock} label="waiting for you" />
          </Show>
        }
        trail={
          <Show when={props.work.running && props.startedAt}>
            {(started) => <Elapsed since={started()} />}
          </Show>
        }
        class="min-w-menu self-start"
      >
        <Show when={props.work.running} fallback={<span>Worked</span>}>
          <span class="truncate font-medium text-ink">{props.work.latest}</span>
        </Show>
        <Show when={props.work.actions}>
          <span class="shrink-0 text-label text-ink-3">{plural(props.work.actions, "action")}</span>
        </Show>
      </Collapsible.Trigger>
      <Collapsible.Panel class="mt-1">
        <ol aria-label="Steps" class="flex flex-col py-1">
          <For
            each={props.work.steps}
            fallback={<li class="flex h-8 items-center ps-8 text-row text-ink-3">Nothing yet</li>}
          >
            {(step) => <StepRow step={step} />}
          </For>
        </ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Elapsed(props: { since: number }): JSX.Element {
  const now = useNow();
  return <span aria-label="Elapsed">{clock(now() - props.since)}</span>;
}

const stepStatus: Record<string, Status | undefined> = {
  running: "running",
  error: "failed",
  pending: "needs-you",
};

function StepRow(props: { step: Step }): JSX.Element {
  const note = () =>
    props.step.kind === "permission"
      ? (props.step.answer ?? (props.step.status === "pending" ? undefined : props.step.status))
      : props.step.error;
  return (
    <li class="flex min-h-8 items-center gap-2 ps-2 pe-3 text-row text-ink-2">
      <span class="flex w-4 shrink-0 justify-center text-ink-3">
        <Show
          when={stepStatus[props.step.status]}
          fallback={<Icon path={props.step.kind === "permission" ? glyphs.lock : glyphs.check} size={12} />}
        >
          {(status) => <StatusIcon status={status()} size={12} />}
        </Show>
      </span>
      <span class="min-w-0 flex-1 py-1">
        <span class="break-words">{props.step.label}</span>
        <Show when={note()}>
          {(text) => <span class="block truncate text-label text-ink-3">{text()}</span>}
        </Show>
      </span>
    </li>
  );
}
