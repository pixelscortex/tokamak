/** The lab window as the application shell (Paper "R3b · Double sidebar"):
 * a 40 px top bar that is also the title bar, a rail with one section
 * (Chat), the lab's views listed in the plugin sidebar, and the picked
 * view in the stage. Each view teleports its parts into the shell regions.
 *
 * Tests can open the unlisted fixtures view through `lab-test`. */
import { For, Match, Switch, createSignal } from "solid-js";
import { onHostEvent } from "@tokamak/render";
import { Icon } from "@tokamak/ui/elements";
import { Button, Kbd, Shell, rail } from "@tokamak/ui/components";
import { fill, stroke } from "./icons";
import { SidebarHeader, SidebarLabel, SidebarRow } from "./kit";
import ChatView from "./chat";
import ComposerStatesView from "./composer-states";
import SelectView from "./select";
import ButtonsView from "./buttons";
import FixturesView from "./fixtures";

/** The views in the plugin sidebar, in order. */
export const views = [
  { id: "chat", label: "Chat", meta: "live" },
  { id: "composer", label: "Composer states", meta: "6" },
  { id: "select", label: "Select" },
  { id: "buttons", label: "Buttons and keys" },
] as const;

type View = (typeof views)[number]["id"] | "fixtures";

/** Each rail item's square hit area (the shell's rail metrics). */
const item = `width: ${rail.item}px; height: ${rail.item}px`;

function Rail() {
  return (
    <Shell.Rail>
      {/* One section; the active icon is simply brighter (75% white). */}
      <button
        id="lab-rail-chat"
        aria-label="Chat"
        aria-pressed={true}
        class="relative flex shrink-0 items-center justify-center rounded-[8px] border-0 bg-transparent p-0 text-[#808080] aria-pressed:text-[#bfbfbf]"
        style={item}
      >
        <Icon d={fill.chat} view={256} fill class="size-5" />
      </button>
      <div class="flex-1" />
      <button
        aria-label="Settings"
        class="mb-1 flex shrink-0 items-center justify-center border-0 bg-transparent p-0 text-[#808080]"
        style={item}
      >
        <Icon d={fill.sliders} view={256} fill class="size-5" />
      </button>
    </Shell.Rail>
  );
}

/** The plugin sidebar: the lab's views. */
function Views(props: { active: View; select: (view: View) => void }) {
  return (
    <Shell.Sidebar>
      <SidebarHeader title="Lab" />
      <SidebarLabel first>Views</SidebarLabel>
      <For each={views}>
        {(view) => (
          <SidebarRow
            id={`lab-view-${view.id}`}
            label={view.label}
            meta={"meta" in view ? view.meta : undefined}
            selected={props.active === view.id}
            onClick={() => props.select(view.id)}
          />
        )}
      </For>
    </Shell.Sidebar>
  );
}

/** Top bar parts every view shares: navigation and the command search. */
function TopBar() {
  const nav = (id: string | undefined, d: string, label: string) => (
    <Button id={id} variant="ghost" size="icon" label={label}>
      <Icon d={d} class="size-4" />
    </Button>
  );
  return (
    <>
      <Shell.TopBar at="start">
        {nav(undefined, stroke.sidebarLeft, "Toggle sidebar")}
        {nav("lab-back", stroke.chevronLeft, "Back")}
        {nav(undefined, stroke.chevronRight, "Forward")}
      </Shell.TopBar>
      <Shell.TopBar at="center">
        <div window-no-drag class="flex w-[400px] max-w-full min-w-0">
          <div
            id="lab-search"
            class="bg-well rounded-[8px] flex h-[30px] w-full min-w-0 items-center gap-2 pr-2 pl-2.5"
          >
            <Icon d={stroke.search} class="size-3.5 text-ink-4" />
            <span class="min-w-0 flex-1 truncate text-[13px] leading-4 text-ink-4">
              Search or run a command
            </span>
            <Kbd keys={["cmd", "K"]} />
          </div>
        </div>
      </Shell.TopBar>
    </>
  );
}

/** Test-only view selection. */
interface TestRequest {
  view?: View;
}

export default function App() {
  const [view, setView] = createSignal<View>("chat");
  onHostEvent<TestRequest>("lab-test", (request) => {
    if (request.view) setView(request.view);
  });
  return (
    <Shell>
      <TopBar />
      <Rail />
      <Views active={view()} select={setView} />
      <Switch>
        <Match when={view() === "chat"}>
          <ChatView />
        </Match>
        <Match when={view() === "composer"}>
          <ComposerStatesView />
        </Match>
        <Match when={view() === "select"}>
          <SelectView />
        </Match>
        <Match when={view() === "buttons"}>
          <ButtonsView />
        </Match>
        <Match when={view() === "fixtures"}>
          <FixturesView />
        </Match>
      </Switch>
    </Shell>
  );
}
