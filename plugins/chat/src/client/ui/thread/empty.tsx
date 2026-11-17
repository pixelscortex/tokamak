import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Icon } from "@tokamak/ui";
import { folderName, type Agent } from "../../lib/agents";
import { glyphs } from "../../lib/icons";

const starters = [
  { icon: glyphs.folder, text: "Explain how this project is laid out" },
  { icon: glyphs.list, text: "Find a failing test and fix it" },
  { icon: glyphs.edit, text: "Review my uncommitted changes" },
];

function Centre(props: { children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-6 py-12 text-center">
      {props.children}
    </div>
  );
}

/** A new thread: what the agent is for, three ways to start, and the composer below. */
export function EmptyThread(props: {
  agent: Agent | undefined;
  onStart: (text: string) => void;
}): JSX.Element {
  return (
    <Centre>
      <div class="flex flex-col items-center gap-2">
        <Icon path={props.agent?.mark ?? glyphs.newChat} class="mb-2 text-ink" />
        <h2 class="text-read font-semibold text-ink">
          What should {props.agent?.name ?? "the agent"} work on?
        </h2>
        <p class="max-w-read text-row text-ink-2">
          It reads, edits and runs commands in{" "}
          <Show when={props.agent?.folder} fallback="your home folder">
            {(folder) => <span class="font-mono text-ink">{folderName(folder())}</span>}
          </Show>
          , and asks before anything risky.
        </p>
      </div>
      <ul aria-label="Ways to start" class="flex w-full max-w-dialog flex-col gap-1">
        <For each={starters}>
          {(starter) => (
            <li>
              <button
                type="button"
                class="flex min-h-8 w-full cursor-pointer items-center gap-3 rounded-sm bg-hover px-3 py-2 text-start text-row text-ink focus-ring hover:bg-selected"
                onClick={() => props.onStart(starter.text)}
              >
                <Icon path={starter.icon} class="text-ink-3" />
                {starter.text}
              </button>
            </li>
          )}
        </For>
      </ul>
    </Centre>
  );
}

/** No agent CLI was found on this machine: say what to install, then check again. */
export function NoAgents(props: { checking: boolean; error?: string; onCheck: () => void }): JSX.Element {
  return (
    <Centre>
      <div class="flex flex-col items-center gap-2">
        <Icon path={glyphs.warning} class="mb-2 text-ink-3" />
        <h2 class="text-read font-semibold text-ink">
          {props.error ? "Could not look for agents" : "No agents found"}
        </h2>
        <p class="max-w-read text-row text-ink-2">
          <Show
            when={props.error}
            fallback={
              <>
                Chat talks to an agent program on this computer. Install{" "}
                <span class="font-mono text-ink">claude-agent-acp</span> or{" "}
                <span class="font-mono text-ink">codex-acp</span>, then check again.
              </>
            }
          >
            {(error) => error()}
          </Show>
        </p>
      </div>
      <Button variant="primary" icon={glyphs.retry} disabled={props.checking} onClick={() => props.onCheck()}>
        {props.checking ? "Checking…" : "Check again"}
      </Button>
    </Centre>
  );
}
