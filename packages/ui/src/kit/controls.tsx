import { For, createSignal } from "solid-js";
import {
  Avatar,
  Button,
  Chip,
  Icon,
  Kbd,
  StatusIcon,
  Tabs,
  Textarea,
  icons,
  type ButtonVariant,
  type Status,
} from "@tokamak/ui";
import type { JSX } from "@solidjs/web";
import { Caption, Section } from "./frame.tsx";
import { tokenContrast } from "./contrast.ts";

const variants: ButtonVariant[] = ["brand", "primary", "outline", "destructive", "ghost"];
const states = ["rest", "hover", "focus", "pressed", "disabled"] as const;
const preview = { rest: undefined, hover: "hover", focus: "focus", pressed: "pressed", disabled: undefined };

export function Buttons(): JSX.Element {
  return (
    <Section label="Primitives · Button" title="Keys: brand or primary once per region">
      <div class="grid grid-cols-6 items-center gap-3">
        <span />
        <For each={states}>{(state) => <Caption>{state}</Caption>}</For>
        <For each={variants}>
          {(variant) => (
            <>
              <Caption>{variant}</Caption>
              <For each={states}>
                {(state) => (
                  <Button
                    variant={variant}
                    data-preview={preview[state]}
                    disabled={state === "disabled"}
                    tabindex={state === "rest" ? 0 : -1}
                  >
                    {variant === "destructive" ? "Delete" : "Merge"}
                  </Button>
                )}
              </For>
            </>
          )}
        </For>
        <Caption>icon only</Caption>
        <For each={states}>
          {(state) => (
            <Button
              variant="ghost"
              icon={icons.more}
              label="Thread actions"
              data-preview={preview[state]}
              disabled={state === "disabled"}
              tabindex={-1}
            />
          )}
        </For>
      </div>
      <div class="flex items-center gap-3">
        <Button variant="primary" size="lg">
          Large · 48
        </Button>
        <Button size="lg" icon={icons.add}>
          New thread
        </Button>
        <Button variant="outline" icon={icons.add} label="Add" size="lg" />
        <Caption>lg (48) matches a roomy row; use it only there.</Caption>
      </div>
    </Section>
  );
}

export function Facts(): JSX.Element {
  const statuses: Status[] = ["running", "needs-you", "done", "failed"];
  return (
    <Section label="Primitives · Chip, Kbd, Avatar, StatusIcon, Icon" title="Small facts">
      <div class="flex flex-wrap items-center gap-2">
        <Chip mono>
          invoices.ts <span class="text-added">+42</span> <span class="text-removed">−3</span>
        </Chip>
        <Chip>feat/csv-export</Chip>
        <Chip tone="added" label="3 checks passed">
          ✓ 3
        </Chip>
        <Chip tone="warn" label="2 need you">
          ! 2
        </Chip>
        <Chip tone="info" size="sm">
          i 1
        </Chip>
        <Chip tone="removed" size="sm" label="1 failed">
          × 1
        </Chip>
      </div>
      <div class="flex items-center gap-6">
        <span class="flex items-center gap-2 text-row text-ink-2">
          New chat <Kbd keys="mod+n" />
        </span>
        <span class="flex items-center gap-2 text-row text-ink-2">
          Stop <Kbd keys="esc" />
        </span>
        <Avatar name="Kira" />
        <Avatar name="Ana" size={16} />
      </div>
      <div class="flex items-center gap-6">
        <For each={statuses}>
          {(status) => (
            <span class="flex items-center gap-2 text-ink-3">
              <StatusIcon status={status} />
              <span class="text-label">{status}</span>
            </span>
          )}
        </For>
      </div>
      <div class="flex items-center gap-4 text-ink-3">
        <For each={[icons.search, icons.add, icons.more, icons.check, icons.close, icons.arrowUp]}>
          {(path) => <Icon path={path} />}
        </For>
        <span class="text-ink">
          <Icon path={icons.search} />
        </span>
        <Caption>16 in a 32 target. Idle tertiary, current ink.</Caption>
      </div>
    </Section>
  );
}

export function Fields(props: { theme: string }): JSX.Element {
  return (
    <Section label="Primitives · Textarea, Tabs" title="Text and panels">
      <div class="grid grid-cols-2 items-start gap-4">
        <Textarea aria-label={`Empty note, ${props.theme}`} placeholder="Ask Mira" />
        <Textarea
          aria-label={`Filled note, ${props.theme}`}
          value={
            "Move the dentist to next week,\nadd groceries to my todos,\nand draft a note to the landlord."
          }
        />
        <Textarea aria-label={`Focused note, ${props.theme}`} data-preview="focus" placeholder="Focused" />
        <Textarea aria-label={`Disabled note, ${props.theme}`} disabled placeholder="Disabled" />
      </div>
      <Tabs.Root defaultValue="changes">
        <Tabs.List aria-label={`Review panel, ${props.theme}`}>
          <Tabs.Tab value="files">Files</Tabs.Tab>
          <Tabs.Tab value="changes">
            Changes <span class="text-data text-ink-3">4</span>
          </Tabs.Tab>
          <Tabs.Tab value="checks" data-preview="hover">
            Checks <span class="text-data text-ink-3">3</span>
          </Tabs.Tab>
          <Tabs.Tab value="review" disabled>
            Review
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="files">
          <p class="pt-3 text-row text-ink-2">Four files changed.</p>
        </Tabs.Panel>
        <Tabs.Panel value="changes">
          <p class="pt-3 text-row text-ink-2">+86 −21 across four files.</p>
        </Tabs.Panel>
        <Tabs.Panel value="checks">
          <p class="pt-3 text-row text-ink-2">Three checks passed.</p>
        </Tabs.Panel>
        <Tabs.Panel value="review">
          <p class="pt-3 text-row text-ink-2">No review yet.</p>
        </Tabs.Panel>
      </Tabs.Root>
      <Caption>Tabs: selected, rest, hover (Checks), disabled (Review).</Caption>
    </Section>
  );
}

const tones = ["window", "stage", "tray", "card", "band"] as const;
const surfaceClass = {
  window: "surface-window",
  stage: "surface-stage",
  tray: "surface-tray",
  card: "surface-card",
  band: "surface-band",
} as const;

function EdgeRatio(props: { tone: (typeof tones)[number] }): JSX.Element {
  const [ratio, setRatio] = createSignal(0);
  return (
    <span
      class="text-data text-ink-3"
      ref={(element) =>
        requestAnimationFrame(() => setRatio(tokenContrast(element, "edge-strong", props.tone)))
      }
    >
      edge {ratio().toFixed(2)}
    </span>
  );
}

export function OnSurfaces(): JSX.Element {
  return (
    <Section label="Primitives · Button on every surface" title="Translucent edges adapt">
      <div class="flex flex-col">
        <For each={tones}>
          {(tone) => (
            <div class={`flex items-center gap-2 px-3 py-2 ${surfaceClass[tone]}`}>
              <span class="w-12 text-data text-ink-3">{tone}</span>
              <For each={variants}>
                {(variant) => (
                  <Button variant={variant} tabindex={-1}>
                    {variant === "destructive" ? "Delete" : "Save"}
                  </Button>
                )}
              </For>
              <Button variant="outline" icon={icons.add} label={`Add on ${tone}`} tabindex={-1} />
              <EdgeRatio tone={tone} />
            </div>
          )}
        </For>
      </div>
      <Caption>edge = the outline's ring (edge-strong) measured over each surface; it needs 3.</Caption>
    </Section>
  );
}
