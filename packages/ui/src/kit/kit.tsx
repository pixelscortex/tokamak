/*
  <Kit />

  Every token and primitive in dark and light side by side, in each state.
  Mounted by the app at /kit.
*/
import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Tabs } from "@tokamak/ui";
import { Buttons, Facts, Fields, OnSurfaces } from "./controls.tsx";
import { Themes } from "./frame.tsx";
import { Overlays } from "./overlays.tsx";
import { Rows } from "./rows.tsx";
import { Space, Tones, Type } from "./tokens.tsx";

export function Kit(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <div id="kit" data-theme="dark" class="surface-window">
      <Tabs.Root defaultValue="tokens">
        <div class="flex items-center gap-4 bg-window px-8 pt-6 pb-4">
          <h2 class="text-read font-semibold text-ink">Tokamak UI kit</h2>
          <Tabs.List aria-label="Kit sections">
            <Tabs.Tab value="tokens">Tokens</Tabs.Tab>
            <Tabs.Tab value="controls">Controls</Tabs.Tab>
            <Tabs.Tab value="rows">Rows</Tabs.Tab>
            <Tabs.Tab value="overlays">Popups</Tabs.Tab>
          </Tabs.List>
        </div>
        <Tabs.Panel value="tokens">
          <Themes>
            {() => (
              <>
                <Tones />
                <Type />
                <Space />
              </>
            )}
          </Themes>
        </Tabs.Panel>
        <Tabs.Panel value="controls">
          <Themes>
            {(theme) => (
              <>
                <Buttons />
                <OnSurfaces />
                <Facts />
                <Fields theme={theme} />
              </>
            )}
          </Themes>
        </Tabs.Panel>
        <Tabs.Panel value="rows">
          <Themes>{(theme) => <Rows theme={theme} />}</Themes>
        </Tabs.Panel>
        <Tabs.Panel value="overlays">
          <div class="flex items-center gap-4 bg-window px-8 pb-4">
            <Button variant="outline" onClick={() => setOpen(!open())}>
              {open() ? "Close the popups" : "Show the popups open"}
            </Button>
          </div>
          <Show
            when={open()}
            fallback={<Themes>{(theme) => <Overlays theme={theme} open={false} />}</Themes>}
          >
            <Themes>{(theme) => <Overlays theme={theme} open />}</Themes>
          </Show>
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
