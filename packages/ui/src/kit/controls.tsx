import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Avatar } from "../avatar.tsx";
import { Button, type ButtonVariant } from "../button.tsx";
import { Chip } from "../chip.tsx";
import { Icon } from "../icon.tsx";
import { icons } from "../icons.ts";
import { Kbd } from "../kbd.tsx";
import { StatusIcon, type Status } from "../status-icon.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../tabs.tsx";
import { Textarea } from "../textarea.tsx";
import { Caption, Section } from "./frame.tsx";

const variants: ButtonVariant[] = ["brand", "primary", "secondary", "outline", "destructive", "ghost"];
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
          Large · 40
        </Button>
        <Button size="lg" icon={icons.add}>
          New thread
        </Button>
        <Button variant="outline" icon={icons.add} label="Add" size="lg" />
        <Caption>lg is for roomy regions only.</Caption>
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
      <div class="grid grid-cols-2 gap-4">
        <Textarea aria-label={`Empty note, ${props.theme}`} placeholder="Ask Mira" />
        <Textarea
          aria-label={`Filled note, ${props.theme}`}
          value={"Move the dentist to next week,\nadd groceries to my todos,\nand draft a note to the landlord."}
        />
        <Textarea aria-label={`Focused note, ${props.theme}`} data-preview="focus" placeholder="Focused" />
        <Textarea aria-label={`Disabled note, ${props.theme}`} disabled placeholder="Disabled" />
      </div>
      <Tabs defaultValue="changes">
        <TabsList aria-label={`Review panel, ${props.theme}`}>
          <TabsTab value="files">Files</TabsTab>
          <TabsTab value="changes">
            Changes <span class="text-data text-ink-3">4</span>
          </TabsTab>
          <TabsTab value="checks" data-preview="hover">
            Checks <span class="text-data text-ink-3">3</span>
          </TabsTab>
          <TabsTab value="review" disabled>
            Review
          </TabsTab>
        </TabsList>
        <TabsPanel value="files" class="pt-3 text-row text-ink-2">
          Four files changed.
        </TabsPanel>
        <TabsPanel value="changes" class="pt-3 text-row text-ink-2">
          +86 −21 across four files.
        </TabsPanel>
        <TabsPanel value="checks" class="pt-3 text-row text-ink-2">
          Three checks passed.
        </TabsPanel>
        <TabsPanel value="review" class="pt-3 text-row text-ink-2">
          No review yet.
        </TabsPanel>
      </Tabs>
      <Caption>Tabs: selected, rest, hover (Checks), disabled (Review).</Caption>
    </Section>
  );
}
