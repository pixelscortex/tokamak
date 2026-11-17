/*
  <Kit />

  Every token and primitive in dark and light side by side, in each state.
  Mounted by the app at /kit. Imports its own stylesheet, so it renders
  right whatever the host page loads.
*/
import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "@tokamak/ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@tokamak/ui/tabs";
import { Buttons, Facts, Fields, OnSurfaces } from "./controls.tsx";
import { Themes } from "./frame.tsx";
import { Overlays } from "./overlays.tsx";
import { Rows } from "./rows.tsx";
import { Space, Tones, Type } from "./tokens.tsx";
import "./kit.css";

export function Kit(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <div data-kit="" id="kit" data-theme="dark">
      <Tabs defaultValue="tokens">
        <div class="flex items-center gap-4 bg-window px-8 pt-6 pb-4">
          <h2 class="text-read font-semibold text-ink">Tokamak UI kit</h2>
          <TabsList aria-label="Kit sections">
            <TabsTab value="tokens">Tokens</TabsTab>
            <TabsTab value="controls">Controls</TabsTab>
            <TabsTab value="rows">Rows</TabsTab>
            <TabsTab value="overlays">Popups</TabsTab>
          </TabsList>
        </div>
        <TabsPanel value="tokens">
          <Themes>
            {() => (
              <>
                <Tones />
                <Type />
                <Space />
              </>
            )}
          </Themes>
        </TabsPanel>
        <TabsPanel value="controls">
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
        </TabsPanel>
        <TabsPanel value="rows">
          <Themes>{(theme) => <Rows theme={theme} />}</Themes>
        </TabsPanel>
        <TabsPanel value="overlays">
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
        </TabsPanel>
      </Tabs>
    </div>
  );
}
