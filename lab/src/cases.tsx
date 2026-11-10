/** Real shared controls, not a second component library or product backend. */
import { For, Show, createSignal } from "solid-js";
import { Button, Input } from "@tokamak/ui/elements";
import FusedSurfaces from "./fused";

function Inputs() {
  const [name, setName] = createSignal("Personal workspace");
  const [identifier, setIdentifier] = createSignal("");
  return <div class="stack">
    <Input id="lab-controlled" label="Workspace name" value={name()} onValueChange={setName}
      description="Controlled: the owner accepts each edit." />
    <Input id="lab-uncontrolled" label="Quick note" defaultValue="Try editing this"
      description="Uncontrolled: the input owns its value." />
    <Input id="lab-invalid" label="Project identifier" value={identifier()} onValueChange={setIdentifier}
      invalid={!identifier().trim()} description={identifier().trim() ? "Ready to use." : "A project identifier is required."} />
    <p id="lab-input-value">Owner value: {name()}</p>
  </div>;
}

function Actions() {
  const [count, setCount] = createSignal(0);
  const [pressed, setPressed] = createSignal(false);
  return <div class="stack">
    <Button id="lab-action" onClick={() => setCount(count() + 1)}>Run action</Button>
    <p id="lab-action-count">{count()} activations</p>
    <Button id="lab-toggle" pressed={pressed()} onPressedChange={setPressed}>
      {pressed() ? "Notifications on" : "Enable notifications"}
    </Button>
    <Button id="lab-disabled-action" disabled onClick={() => setCount(count() + 100)}>Unavailable action</Button>
    <p>Try Tab, Enter and Space through the native input path.</p>
  </div>;
}

function Settings() {
  const [name, setName] = createSignal("Design workspace");
  const [saved, setSaved] = createSignal("No changes saved");
  return <div class="stack">
    <Input id="lab-setting" label="Display name" value={name()} onValueChange={setName} />
    <Input id="lab-readonly" label="Account" value="Personal account" readonly />
    <Input id="lab-disabled-input" label="Team connection" value="Not connected" disabled />
    <Button id="lab-save" disabled={!name().trim()} onClick={() => setSaved(`Saved preview: ${name().trim()}`)}>Save preview</Button>
    <p id="lab-save-status" role="status">{saved()}</p>
  </div>;
}

function Foundations() {
  return <div class="stack">
    <p>One semantic theme, shared by the lab and UI primitives.</p>
    <For each={["canvas", "surface", "foreground", "accent"]}>{token =>
      <div class="token"><span class={`swatch swatch-${token}`} /><span>{token}</span></div>
    }</For>
    <p>System fonts · native rendering · no webview</p>
  </div>;
}

const cases = [
  { id: "inputs", title: "Text input", category: "Inputs", component: Inputs },
  { id: "actions", title: "Actions & state", category: "Buttons", component: Actions },
  { id: "settings", title: "Workspace preferences", category: "Compositions", component: Settings },
  { id: "foundations", title: "Foundations", category: "Compositions", component: Foundations },
];

export default function ComponentLab() {
  const [category, setCategory] = createSignal("All");
  const [revision, setRevision] = createSignal(1);
  return <main id="lab" class="p-[18px] min-[681px]:p-7 max-w-[1500px] mx-auto">
    <header class="header"><span>Tokamak / UI</span><span class="eyebrow">NATIVE COMPONENT LAB</span></header>
    <div class="intro">
      <div><p class="eyebrow">BUILDING BLOCKS, IN CONTEXT</p><h1>Component lab</h1>
        <p>A living workspace for the primitives we build next.</p></div>
      <Button id="lab-reset" onClick={() => { setCategory("All"); setRevision(revision() + 1); }}>Reset examples</Button>
    </div>
    <nav class="toolbar" aria-label="Component categories">
      <For each={["All", "Buttons", "Inputs", "Compositions"]}>{item =>
        <Button id={`lab-filter-${item.toLowerCase()}`} pressed={category() === item} onClick={() => setCategory(item)}>{item}</Button>
      }</For>
    </nav>
    <Show when={revision()} keyed>{(_revision: number) =>
      <div class="grid grid-cols-1 min-[681px]:grid-cols-2 min-[1001px]:grid-cols-3 gap-5 items-start">
        <For each={cases}>{entry =>
          <Show when={category() === "All" || category() === entry.category}>
            <section class="card" id={`lab-case-${entry.id}`}>
              <header class="card-header"><p class="eyebrow">{entry.category}</p><h2>{entry.title}</h2></header>
              <div class="card-body"><entry.component /></div>
            </section>
          </Show>
        }</For>
      </div>
    }</Show>
    <FusedSurfaces />
    <footer>No database or account required. Add new cases here as primitives become real.</footer>
  </main>;
}
