/** Select view: the field size closed and open (with groups and search),
 * the compact size of toolbars and the composer, and a menu that opens
 * upward. Every select is live; the open one starts open (`defaultOpen`)
 * and closes like any other. */
import { createSignal } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Select, Shell } from "@tokamak/ui/components";
import { SectionTitle } from "./kit";
import * as mocks from "./mocks";

function Case(props: { title: string; value?: string; id?: string; class?: string; children: JSX.Element }) {
  return (
    <div class={`flex flex-col gap-2.5 ${props.class ?? ""}`}>
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-[12px] leading-4 font-medium text-ink-3">{props.title}</span>
        <span id={props.id} class="font-data text-[11px] leading-4 text-ink-5">{props.value ?? ""}</span>
      </div>
      {props.children}
    </div>
  );
}

export default function SelectView() {
  const [list, setList] = createSignal("inbox");
  const [open, setOpen] = createSignal("groceries");
  const [model, setModel] = createSignal("openrouter/free");
  const [up, setUp] = createSignal("normal");
  return (
    <Shell.Stage>
      <div id="lab-select" class="flex flex-col gap-8 px-8 pt-8 pb-16">
        <SectionTitle eyebrow="SELECT" title="Field size, 34 px">
          A trigger button and a menu in a sheet of its own, 4 px below it. Up and Down move, Enter picks,
          Escape or a click outside closes.
        </SectionTitle>
        <div class="flex flex-wrap items-start gap-8">
          <Case title="Closed" value={list()} id="lab-select-field-value" class="w-[260px]">
            <Select id="lab-select-field" label="List" placeholder="Pick a list" options={mocks.lists} value={list()} onValueChange={setList} />
          </Case>
          <Case title="Open, with groups and search" value={open()} id="lab-select-open-value" class="h-[380px] w-[280px]">
            <Select
              id="lab-select-open"
              label="List"
              options={mocks.lists}
              value={open()}
              onValueChange={setOpen}
              search
              searchPlaceholder="Find a list"
              defaultOpen
            />
          </Case>
        </div>
        <SectionTitle eyebrow="COMPACT" title="Compact size, 26 px">
          For toolbars and the composer: no plate until hover, values in the data font.
        </SectionTitle>
        <div class="flex flex-wrap items-end gap-8">
          <Case title="Compact" value={model()} id="lab-select-compact-value" class="w-[260px]">
            <div class="flex">
              <Select id="lab-select-compact" label="Model" size="compact" mono search options={mocks.models} value={model()} onValueChange={setModel} />
            </div>
          </Case>
          <Case title="Opening upward" value={up()} id="lab-select-up-value" class="w-[260px] pt-[150px]">
            <Select id="lab-select-up" label="Priority" side="top" options={mocks.priorities} value={up()} onValueChange={setUp} />
          </Case>
          <Case title="Disabled" class="w-[200px]">
            <Select id="lab-select-disabled" label="List" options={mocks.lists} value="inbox" disabled />
          </Case>
        </div>
      </div>
    </Shell.Stage>
  );
}
