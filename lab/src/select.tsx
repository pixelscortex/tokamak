/** Field and compact selects, with search and automatic placement. */
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
        <span id={props.id} class="font-data text-[11px] leading-4 text-ink-5">
          {props.value ?? ""}
        </span>
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
  const [merged, setMerged] = createSignal("normal");
  const [flip, setFlip] = createSignal("today");
  return (
    <Shell.Stage>
      <div id="lab-select" class="flex flex-col gap-8 px-8 pt-8 pb-16">
        <SectionTitle eyebrow="SELECT" title="Field size, 34 px">
          The trigger and menu are separate boxes, 6 px apart. Up and Down move, Enter picks, Escape or a
          click outside closes.
        </SectionTitle>
        <div class="flex flex-wrap items-start gap-8">
          <Case title="Closed" value={list()} id="lab-select-field-value" class="w-[240px]">
            <Select
              id="lab-select-field"
              label="List"
              placeholder="Pick a list"
              options={mocks.lists}
              value={list()}
              onValueChange={setList}
            />
          </Case>
          <Case
            title="Open below, with search"
            value={open()}
            id="lab-select-open-value"
            class="h-[330px] w-[260px]"
          >
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
          <Case title="Open above" value={up()} id="lab-select-up-value" class="h-[330px] w-[240px]">
            <Select
              id="lab-select-up"
              class="mt-auto"
              label="Priority"
              side="top"
              options={mocks.priorities}
              value={up()}
              onValueChange={setUp}
              defaultOpen
            />
          </Case>
        </div>
        <SectionTitle eyebrow="COMPACT" title="Compact size, 26 px">
          For toolbars and the composer: a small trigger and a separate menu. At the bottom of a scrolling box
          the menu opens upward by itself.
        </SectionTitle>
        <div class="flex flex-wrap items-start gap-8">
          <Case title="Compact, models" value={model()} id="lab-select-compact-value" class="w-[260px]">
            <div class="flex">
              <Select
                id="lab-select-compact"
                label="Model"
                size="compact"
                mono
                search
                options={mocks.models}
                value={model()}
                onValueChange={setModel}
              />
            </div>
          </Case>
          <Case
            title="Compact, priority"
            value={merged()}
            id="lab-select-merged-value"
            class="h-[170px] w-[260px]"
          >
            <div class="flex">
              <Select
                id="lab-select-merged"
                label="Priority"
                size="compact"
                options={mocks.priorities}
                value={merged()}
                onValueChange={setMerged}
                defaultOpen
              />
            </div>
          </Case>
          <Case
            title="Flips up in a scrolling box"
            value={flip()}
            id="lab-select-flip-value"
            class="w-[260px]"
          >
            <div
              id="lab-select-flip-box"
              class="flex h-[150px] flex-col gap-2 overflow-y-auto rounded-md bg-well p-2"
            >
              <span class="text-[12px] leading-4 text-ink-4">A short scrolling box.</span>
              <span class="text-[12px] leading-4 text-ink-4">The select sits at its bottom.</span>
              <div class="flex-1" />
              <Select
                id="lab-select-flip"
                label="List"
                options={mocks.lists}
                value={flip()}
                onValueChange={setFlip}
                defaultOpen
              />
            </div>
          </Case>
          <Case title="Disabled" class="w-[200px]">
            <Select id="lab-select-disabled" label="List" options={mocks.lists} value="inbox" disabled />
          </Case>
        </div>
      </div>
    </Shell.Stage>
  );
}
