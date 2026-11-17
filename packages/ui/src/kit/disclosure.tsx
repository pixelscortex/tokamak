import type { JSX } from "@solidjs/web";
import { CodeBlock, Collapsible, StatusIcon } from "@tokamak/ui";
import { Caption, Section } from "./frame.tsx";

const sample = `export function total(rows: Row[]) {
  return rows.reduce((sum, row) => sum + row.cents, 0);
}`;

export function Disclosure(props: { theme: string }): JSX.Element {
  return (
    <Section label="Primitives · Collapsible, CodeBlock" title="Folded work and code">
      <div class="flex flex-col items-start gap-2 surface-stage p-4">
        <Collapsible.Root>
          <Collapsible.Trigger
            aria-label={`Worked, 4 actions, ${props.theme}`}
            lead={<StatusIcon status="done" />}
            trail="12s"
            class="min-w-menu"
          >
            Worked <span class="text-label text-ink-3">4 actions</span>
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <p class="px-2 py-2 text-row text-ink-2">Read session.ts · Ran the auth tests</p>
          </Collapsible.Panel>
        </Collapsible.Root>
        <Collapsible.Root>
          <Collapsible.Trigger variant="quiet" lead={<StatusIcon status="running" />} trail="0:04">
            <span class="font-medium text-ink">Checking your calendar</span>
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <p class="px-2 py-2 text-row text-ink-2">Opened the calendar</p>
          </Collapsible.Panel>
        </Collapsible.Root>
        <CodeBlock code={sample} language="ts" class="w-full" />
      </div>
      <Caption>Collapsible: filled and quiet triggers. CodeBlock: language and a copy key.</Caption>
    </Section>
  );
}
