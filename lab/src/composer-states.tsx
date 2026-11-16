/** Composer states: each state of the one `Composer` as its own live
 * composer, labelled, one under another. Free plates here (`docked` is the
 * chat view's); everything they show comes from mocks.ts. */
import { createSignal } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Composer, Shell } from "@tokamak/ui/components";
import * as mocks from "./mocks";

/** One labelled state; `note` reports what the last action did. */
function State(props: { id: string; title: string; hint: string; note?: string; children: JSX.Element }) {
  return (
    <section id={`lab-state-${props.id}`} class="flex w-full max-w-[640px] flex-col gap-3">
      <header class="flex items-baseline gap-3">
        <h2 class="m-0 text-[14px] leading-5 font-semibold text-ink">{props.title}</h2>
        <span class="text-[12px] leading-4 text-ink-4">{props.hint}</span>
        <span class="flex-1" />
        <span id={`lab-state-${props.id}-note`} class="font-data text-[11px] leading-4 text-ink-3">
          {props.note ?? ""}
        </span>
      </header>
      {props.children}
    </section>
  );
}

export default function ComposerStatesView() {
  const [model, setModel] = createSignal("openrouter/free");
  const [sent, setSent] = createSignal("");
  const [chips, setChips] = createSignal(mocks.context);
  const [stopped, setStopped] = createSignal("");
  const [picked, setPicked] = createSignal("");
  const [list, setList] = createSignal("inbox");
  const [due, setDue] = createSignal("friday");
  const [priority, setPriority] = createSignal("normal");
  const [created, setCreated] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const common = {
    models: mocks.models,
    get model() {
      return model();
    },
    onModelChange: setModel,
  };
  return (
    <Shell.Stage>
      <div id="lab-composer-states" class="flex flex-col items-center gap-9 px-8 pt-10 pb-16">
        <State id="idle" title="Idle" hint="placeholder, model, send dim until there is text" note={sent()}>
          <Composer
            id="lab-idle"
            placeholder="Ask anything…"
            onSubmit={(t) => setSent(`sent: ${t}`)}
            {...common}
          />
        </State>
        <State id="context" title="With context" hint="two rows at most, then +N more">
          <Composer
            id="lab-context"
            placeholder="Ask about these…"
            context={chips()}
            onRemoveContext={(id) => setChips(chips().filter((c) => c.id !== id))}
            {...common}
          />
        </State>
        <State id="running" title="Running" hint="status shelf; send becomes stop" note={stopped()}>
          <Composer
            id="lab-running"
            placeholder="Add a follow-up…"
            running={mocks.run}
            onStop={() => setStopped("stopped")}
            {...common}
          />
        </State>
        <State id="commands" title="Commands" hint="typing / lists commands" note={picked()}>
          <Composer
            id="lab-commands"
            defaultValue="/"
            commands={mocks.commands}
            onCommand={(c) => setPicked(`picked: /${c.name}`)}
            {...common}
          />
        </State>
        <State id="form" title="Command form" hint="tag, title, option selects, Create" note={created()}>
          <Composer
            id="lab-form"
            form={{
              tag: "/todo",
              placeholder: "Task title",
              fields: [
                ...mocks.todoFields([list(), setList], [due(), setDue]),
                {
                  id: "priority",
                  label: "Priority",
                  options: mocks.priorities,
                  value: priority(),
                  onChange: setPriority,
                },
              ],
              onSubmit: (title) => setCreated(`created: ${title || "untitled"} (${list()}, ${due()})`),
              onCancel: () => setCreated("cancelled"),
            }}
            {...common}
          />
        </State>
        <State id="approval" title="Approval" hint="a question before the run goes on" note={answer()}>
          <Composer
            id="lab-approval"
            placeholder="Reply…"
            approval={{
              ...mocks.approval,
              onDeny: () => setAnswer("denied"),
              onAllowOnce: () => setAnswer("allowed once"),
              onAlwaysAllow: () => setAnswer("always allowed"),
            }}
            {...common}
          />
        </State>
      </div>
    </Shell.Stage>
  );
}
