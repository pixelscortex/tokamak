/** The lab window as the application shell (Paper "R3b · Double sidebar"):
 * a 40 px top bar that is also the title bar, a rail with one item per lab
 * section (the active one is simply brighter), the
 * section's list in the plugin sidebar, and the section in the stage. Each
 * section is a view that teleports its parts into the shell regions. */
import { For, Match, Switch, createSignal } from "solid-js";
import { Icon } from "@tokamak/ui/elements";
import { Shell, Surface, rail } from "@tokamak/ui/components";
import type { PlatePainter } from "@tokamak/ui/components";
import { fill, stroke } from "./icons";
import { IconButton } from "./kit";
import ChatView from "./chat";
import ComponentsView from "./cases";
import SurfacesView from "./surfaces";
import StressView from "./stress";

const sections = [
  { id: "chat", label: "Chat", icon: fill.chat },
  { id: "components", label: "Components", icon: fill.checkSquare },
  { id: "surfaces", label: "Surfaces", icon: fill.kanban },
  { id: "stress", label: "Stress", icon: fill.codeBlock },
] as const;

type Section = (typeof sections)[number]["id"];

/** Each rail item's square hit area (the shell's rail metrics). */
const item = `width: ${rail.item}px; height: ${rail.item}px`;

function Rail(props: { active: Section; select: (section: Section) => void }) {
  return (
    <Shell.Rail>
      {/* Kept plain for now: every icon at 50% white, the active one at
       * 75%. The fused tab (a `Surface.Union` on the sidebar layer with
       * `attach="right"`) is removed here, not from the primitives. */}
      <For each={sections}>
        {(section) => (
          <button
            id={`lab-rail-${section.id}`}
            aria-label={section.label}
            aria-pressed={props.active === section.id}
            onClick={() => props.select(section.id)}
            class="relative flex shrink-0 items-center justify-center rounded-[8px] border-0 bg-transparent p-0 text-[#808080] aria-pressed:text-[#bfbfbf]"
            style={item}
          >
            <Icon d={section.icon} view={256} fill class="size-5" />
          </button>
        )}
      </For>
      <button
        aria-label="New section"
        class="flex shrink-0 items-center justify-center border-0 bg-transparent p-0 text-[#808080]"
        style={item}
      >
        <Icon d={stroke.plus} strokeWidth={2} class="size-[18px]" />
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

/** Top bar parts every section shares: navigation, the command search and
 * the switch between the two plate painters for every shell region (each
 * plate painting itself, or each region's sheet drawing its plates). */
function TopBar(props: { plates: PlatePainter; setPlates: (plates: PlatePainter) => void }) {
  return (
    <>
      <Shell.TopBar at="start">
        <IconButton d={stroke.sidebarLeft} label="Toggle sidebar" />
        <IconButton id="lab-back" d={stroke.chevronLeft} label="Back" />
        <IconButton d={stroke.chevronRight} label="Forward" dim />
      </Shell.TopBar>
      <Shell.TopBar at="center">
        <div window-no-drag class="flex w-[400px] max-w-full min-w-0">
        <Surface
          id="lab-search"
          material="well"
          radius={8}
          class="flex h-[30px] w-full min-w-0 items-center gap-2 pr-2 pl-2.5"
        >
          <Icon d={stroke.search} class="size-3.5 text-ink-4" />
          <span class="min-w-0 flex-1 truncate text-[13px] leading-4 text-ink-4">Search or run a command</span>
          {/* A text run containing ⌘ draws nothing in this Blitz/parley setup
           * (no per-glyph fallback), so ⌘ is an icon and K is text. */}
          <Surface material="chip" radius={4} class="flex items-center gap-px px-1.5 py-0.5 text-ink-3">
            <Icon d={stroke.command} strokeWidth={2.25} class="size-2.5" />
            <span class="font-data text-[11px] leading-[14px]">K</span>
          </Surface>
        </Surface>
        </div>
      </Shell.TopBar>
      <Shell.TopBar at="end">
        <button
          id="lab-plates-mode"
          window-no-drag
          aria-pressed={props.plates === "sheet"}
          onClick={() => props.setPlates(props.plates === "sheet" ? "self" : "sheet")}
          class="material-key active:material-key-pressed aria-pressed:material-key-pressed flex h-6 items-center rounded-[6px] border-0 px-2 font-data text-[10px] tracking-[0.06em] text-ink-body select-none"
        >
          {props.plates === "sheet" ? "PLATES: SHEET" : "PLATES: SELF"}
        </button>
      </Shell.TopBar>
    </>
  );
}

export default function App() {
  const [section, setSection] = createSignal<Section>("chat");
  const [plates, setPlates] = createSignal<PlatePainter>("self");
  return (
    <Shell plates={plates()}>
      <TopBar plates={plates()} setPlates={setPlates} />
      <Rail active={section()} select={setSection} />
      <Switch>
        <Match when={section() === "chat"}>
          <ChatView />
        </Match>
        <Match when={section() === "components"}>
          <ComponentsView />
        </Match>
        <Match when={section() === "surfaces"}>
          <SurfacesView />
        </Match>
        <Match when={section() === "stress"}>
          <StressView />
        </Match>
      </Switch>
    </Shell>
  );
}
