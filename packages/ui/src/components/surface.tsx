/** Fused shapes use CSS for fill, radius and bevel.
 *
 * import { Surface } from "@tokamak/ui/components";
 *
 * <Surface class="surface-panel rounded-xl bevel p-4" join={10}>
 *   <Surface.Add
 *     class="absolute -left-12 top-6 h-10 w-12 rounded-l-lg"
 *     attach="right"
 *   />
 *   <Surface.Cut class="absolute right-4 top-4 size-10 rounded-full">
 *     <button class="size-10 rounded-full bg-chip bevel" aria-label="Run">
 *       Run
 *     </button>
 *   </Surface.Cut>
 *   <p>Panel content</p>
 * </Surface>;
 *
 * Members join the nearest Surface, or a named shell layer via `layer`.
 * `layer="base"` cuts the shell layers above the window background.
 */
import { createContext, createUniqueId, useContext } from "solid-js";
import type { JSX, NativeNode } from "@tokamak/render";

export type ShellLayer = "base" | "sidebar" | "stage";
export const shellGroups = { sidebar: "shell-sidebar", stage: "shell-stage-surface" } as const;
const GroupContext = createContext<string>();

// Position utilities must not compete with the default relative positioning.
const positioned = (cls: string | undefined) =>
  /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(cls ?? "") ? (cls ?? "") : `relative ${cls ?? ""}`;

interface ElementProps {
  id?: string;
  class?: string;
  style?: string;
  ref?: (node: NativeNode) => void;
  children?: JSX.Element;
}

export interface SurfaceProps extends ElementProps {
  join?: number;
  own?: boolean;
}

function SurfaceRoot(props: SurfaceProps): JSX.Element {
  const group = props.id ?? `surface-${createUniqueId()}`;
  return (
    <div
      id={props.id}
      ref={(node) => props.ref?.(node)}
      tk-group={group}
      surface-own={props.own === false ? "false" : undefined}
      surface-join={props.join}
      class={`isolate ${positioned(props.class)}`}
      style={props.style}
    >
      <tk-surface group={group} class="absolute inset-0 -z-10" />
      <GroupContext.Provider value={group}>{props.children}</GroupContext.Provider>
    </div>
  );
}

export interface ShapeProps extends ElementProps {
  join?: number;
  slant?: number | [number, number];
  animate?: boolean;
  layer?: ShellLayer;
}

export interface AddProps extends ShapeProps {
  attach?: "left" | "right" | "top" | "bottom";
}

function shape(op: "add" | "cut") {
  return (props: AddProps): JSX.Element => {
    const local = useContext(GroupContext);
    if (!local && !props.layer) {
      throw new Error("Surface members must be inside a Surface or name a layer");
    }
    const groups = () =>
      props.layer === "base"
        ? `${shellGroups.sidebar} ${shellGroups.stage}`
        : props.layer ? shellGroups[props.layer] : local;
    return (
      <div
        id={props.id}
        ref={(node) => props.ref?.(node)}
        class={positioned(props.class)}
        style={props.style}
        surface-groups={groups()}
        surface-op={props.layer === "base" ? "cut" : op}
        surface-join={props.join}
        surface-slant={Array.isArray(props.slant) ? props.slant.join(" ") : props.slant?.toString()}
        surface-animate={props.animate ? true : undefined}
        surface-attach={op === "add" && props.layer !== "base" ? props.attach : undefined}
      >
        {props.children}
      </div>
    );
  };
}

export const Surface = Object.assign(SurfaceRoot, {
  Add: shape("add"),
  Cut: shape("cut") as (props: ShapeProps) => JSX.Element,
});
