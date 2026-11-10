/** Components section: real shared controls (`@tokamak/ui/elements`), not a
 * second component library. Button and Input keep their own (older) themed
 * classes; the lab around them is Tailwind utilities. */
import { For, Show, createSignal } from "solid-js";
import { Button, Input } from "@tokamak/ui/elements";
import { Shell, Surface } from "@tokamak/ui/components";
import { SidebarHeader, SidebarLabel, SidebarRow } from "./kit";

const text = "m-0 text-[13px] leading-5 text-ink-3";

function Inputs() {
  const [name, setName] = createSignal("Personal workspace");
  const [identifier, setIdentifier] = createSignal("");
  return <div class="flex flex-col gap-[18px]">
    <Input id="lab-controlled" label="Workspace name" value={name()} onValueChange={setName}
      description="Controlled: the owner accepts each edit." />
    <Input id="lab-uncontrolled" label="Quick note" defaultValue="Try editing this"
      description="Uncontrolled: the input owns its value." />
    <Input id="lab-invalid" label="Project identifier" value={identifier()} onValueChange={setIdentifier}
      invalid={!identifier().trim()} description={identifier().trim() ? "Ready to use." : "A project identifier is required."} />
    <p id="lab-input-value" class={text}>Owner value: {name()}</p>
  </div>;
}

function Actions() {
  const [count, setCount] = createSignal(0);
  const [pressed, setPressed] = createSignal(false);
  return <div class="flex flex-col gap-[18px]">
    <Button id="lab-action" onClick={() => setCount(count() + 1)}>Run action</Button>
    <p id="lab-action-count" class={text}>{count()} activations</p>
    <Button id="lab-toggle" pressed={pressed()} onPressedChange={setPressed}>
      {pressed() ? "Notifications on" : "Enable notifications"}
    </Button>
    <Button id="lab-disabled-action" disabled onClick={() => setCount(count() + 100)}>Unavailable action</Button>
    <p class={text}>Try Tab, Enter and Space through the native input path.</p>
  </div>;
}

function Settings() {
  const [name, setName] = createSignal("Design workspace");
  const [saved, setSaved] = createSignal("No changes saved");
  return <div class="flex flex-col gap-[18px]">
    <Input id="lab-setting" label="Display name" value={name()} onValueChange={setName} />
    <Input id="lab-readonly" label="Account" value="Personal account" readonly />
    <Input id="lab-disabled-input" label="Team connection" value="Not connected" disabled />
    <Button id="lab-save" disabled={!name().trim()} onClick={() => setSaved(`Saved preview: ${name().trim()}`)}>Save preview</Button>
    <p id="lab-save-status" role="status" class={text}>{saved()}</p>
  </div>;
}

const cases = [
  { id: "inputs", title: "Text input", category: "Inputs", component: Inputs },
  { id: "actions", title: "Actions & state", category: "Buttons", component: Actions },
  { id: "settings", title: "Workspace preferences", category: "Compositions", component: Settings },
];

export default function ComponentsView() {
  const [category, setCategory] = createSignal("All");
  const [revision, setRevision] = createSignal(1);
  return <>
    <Shell.Sidebar>
      <SidebarHeader title="Components" />
      <SidebarLabel first>Cases</SidebarLabel>
      <For each={cases}>{(entry) =>
        <SidebarRow label={entry.title} meta={entry.category} selected={category() === entry.category} />
      }</For>
    </Shell.Sidebar>
    <Shell.Stage>
      <main id="lab" class="flex flex-col gap-6 px-8 pt-8 pb-10 text-ink">
        <div class="flex items-center justify-between gap-6">
          <div class="flex flex-col gap-2">
            <p class="m-0 text-[11px] tracking-[0.08em] text-ink-4">BUILDING BLOCKS, IN CONTEXT</p>
            <h1 class="m-0 text-[28px] font-semibold tracking-[-0.01em]">Component lab</h1>
            <p class={text}>A living workspace for the primitives we build next.</p>
          </div>
          <Button id="lab-reset" onClick={() => { setCategory("All"); setRevision(revision() + 1); }}>Reset examples</Button>
        </div>
        <nav class="flex flex-wrap gap-2" aria-label="Component categories">
          <For each={["All", "Buttons", "Inputs", "Compositions"]}>{item =>
            <Button id={`lab-filter-${item.toLowerCase()}`} pressed={category() === item} onClick={() => setCategory(item)}>{item}</Button>
          }</For>
        </nav>
        <Show when={revision()} keyed>{(_revision: number) =>
          <div class="flex flex-wrap items-start gap-5">
            <For each={cases}>{entry =>
              <Show when={category() === "All" || category() === entry.category}>
                <Surface material="card" radius={12} id={`lab-case-${entry.id}`}
                  class="flex min-w-[280px] flex-1 basis-[300px] flex-col">
                  <header class="flex flex-col gap-2 px-[22px] pt-[22px] pb-4">
                    <p class="m-0 text-[11px] tracking-[0.08em] text-ink-4">{entry.category}</p>
                    <h2 class="m-0 text-[17px] font-medium">{entry.title}</h2>
                  </header>
                  <div class="px-[22px] pb-[22px]"><entry.component /></div>
                </Surface>
              </Show>
            }</For>
          </div>
        }</Show>
        <p class="m-0 text-[13px] text-ink-4">No database or account required. Add new cases here as primitives become real.</p>
      </main>
    </Shell.Stage>
  </>;
}
