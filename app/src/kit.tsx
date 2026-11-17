import { createSignal } from "solid-js";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@ui-sdk/solid/tabs";
import { Controls } from "./controls";

export function Kit() {
  const [outcome, setOutcome] = createSignal("Exercise the controls without a server connection.");
  return (
    <>
      <section class="stage">
        <h2>UI kit</h2>
        <Controls
          onNew={() => setOutcome("Create thread selected")}
          onDisconnect={() => setOutcome("Disconnect selected")}
        />
        <p role="status" aria-label="Kit action">
          {outcome()}
        </p>
        <Tabs defaultValue="components">
          <TabsList aria-label="Kit sections">
            <TabsTab value="components">Components</TabsTab>
            <TabsTab value="coverage">Coverage</TabsTab>
          </TabsList>
          <TabsPanel value="components">
            <p>Menu, dialog, select, tooltip and tabs use ui-sdk Solid components.</p>
          </TabsPanel>
          <TabsPanel value="coverage">
            <p>
              A future kit needs input, focus, IME, layout and plugin-slot regression scenarios from the
              component catalog.
            </p>
          </TabsPanel>
        </Tabs>
      </section>
    </>
  );
}
