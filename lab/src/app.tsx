/** The lab window as the application shell (Paper "R3b · Double sidebar"):
 * a 40 px top bar that is also the title bar, a rail with one item per lab
 * section whose active item is a tab fused into the plugin container, the
 * section's list in the plugin sidebar, and the section in the stage. Each
 * section is a view that teleports its parts into the shell regions. */
import { For, Match, Switch, createSignal } from "solid-js";
import { Icon } from "@tokamak/ui/elements";
import { Shell, Surface } from "@tokamak/ui/components";
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

/** Rail items 32 px tall with 2 px gaps, so item i starts at i * 34, the
 * first level with the container's top (as in the design file). */
const RAIL_STEP = 34;

function Rail(props: { active: Section; select: (section: Section) => void }) {
  const index = () => sections.findIndex((s) => s.id === props.active);
  return (
    <Shell.Rail>
      {/* The active item's tab: container material attached to the
       * container's left edge (one exact outline with the sidebar layer's
       * 10 px join as fillets), animating between items. On the first item
       * its top edge runs straight into the container's top edge. */}
      <Surface.Union
        layer="sidebar"
        animate
        attach="right"
        radius={[10, 0, 0, 10]}
        class="absolute left-[7px] h-8 w-[39px]"
        style={`top: ${index() * RAIL_STEP}px`}
      />
      <For each={sections}>
        {(section) => (
          <button
            id={`lab-rail-${section.id}`}
            aria-label={section.label}
            aria-pressed={props.active === section.id}
            onClick={() => props.select(section.id)}
            class="relative flex size-8 shrink-0 items-center justify-center rounded-[7px] border-0 bg-transparent p-0 text-ink-4 aria-pressed:text-ink"
          >
            <Icon d={section.icon} view={256} fill class="size-5" />
          </button>
        )}
      </For>
      <button
        aria-label="New section"
        class="flex size-8 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-ink-6"
      >
        <Icon d={stroke.plus} strokeWidth={2} class="size-[18px]" />
      </button>
      <div class="flex-1" />
      <button
        aria-label="Settings"
        class="mb-1 flex size-8 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-ink-4"
      >
        <Icon d={fill.sliders} view={256} fill class="size-5" />
      </button>
    </Shell.Rail>
  );
}

/** Top bar parts every section shares: navigation and the command search. */
function TopBar() {
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
    </>
  );
}

export default function App() {
  const [section, setSection] = createSignal<Section>("chat");
  return (
    <Shell>
      <TopBar />
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
