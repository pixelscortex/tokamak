/** Fused, lit surfaces (render/SURFACES.md) as Solid components.
 *
 * One layer plus boolean shapes placed by normal layout:
 *
 *   <Surface material="card" radius={10} class="p-4">       // the plate
 *     <Surface.Union class="absolute -top-3 left-6 h-6 w-16" radius={6} join={8} />
 *     <Surface.Subtract class="absolute right-4 top-4 size-10" radius={20} gap={3}>
 *       <button … />                                           // content above
 *     </Surface.Subtract>
 *   </Surface>
 *
 * The `Surface` element is the group: its box is the painted area, and by
 * default it is also its first shape (the plate). `Surface.Union` and
 * `Surface.Subtract` are ordinary elements laid out by CSS; their boxes are
 * read by the render host after layout and become shapes of the nearest
 * enclosing `Surface` (booleans only act within their own surface). Their
 * children render above the surface; authors never handle z-index or
 * pointer events. `Surface.Intersect` is reserved for masking (not built).
 *
 * `layer` joins a fixed shell layer (see Shell) instead of the nearest
 * surface: `<Surface.Union layer="base">` makes a shape of window-base
 * material (it cuts every shell layer above the base, so the base shows
 * through, fused with fillets), `layer="sidebar"` fuses into the plugin
 * container, `layer="stage"` into the stage panel.
 */
import { createContext, createUniqueId, splitProps, useContext } from "solid-js";
import type { JSX } from "@tokamak/render";

interface MaterialLook {
  fill: string;
  bevel: number;
  /** Hairline width, CSS px, inside the outline. */
  border?: number;
  /** Hairline strength: how far the border moves from the fill towards
   * white (0.055 = 5.5% white over the fill). */
  borderStrength?: number;
  /** How much the light modulates the hairline: 0 is flat all round, 1 the
   * full swing (bright facing the light, dark facing away). */
  borderLight?: number;
  recessed?: boolean;
}

/** Hairline of the big shell surfaces: a quiet, nearly uniform edge with a
 * hint of light (top edges a little brighter, bottom a little darker). */
const hairline = { border: 1, borderStrength: 0.055, borderLight: 0.25 };

/** Theme-token based looks; colours are `var(--token)` from theme.css, which
 * the native widget resolves from computed style. One place to tune. */
export const materials = {
  base: { fill: "var(--color-base)", bevel: 2 },
  sidebar: { fill: "var(--color-sidebar)", bevel: 2, ...hairline },
  panel: { fill: "var(--color-panel)", bevel: 2, ...hairline },
  card: { fill: "var(--color-card)", bevel: 2 },
  chip: { fill: "var(--color-chip)", bevel: 1.5 },
  well: { fill: "var(--color-well)", bevel: 1.5, recessed: true },
  /** Keycaps: a flat face with a lit edge band, sitting in a `tray` whose
   * base colour shows as the seam between caps. For things you press. */
  key: { fill: "var(--color-chip)", bevel: 2.5 },
  keyBright: { fill: "var(--color-ink)", bevel: 2.5 },
  /** A pressed key (the same look as the `material-key-pressed` utility). */
  keyPressed: { fill: "var(--color-card)", bevel: 2, recessed: true },
  tray: { fill: "var(--color-base)", bevel: 1.5, recessed: true },
} satisfies Record<string, MaterialLook>;

export type Material = keyof typeof materials;

/** Shell layers a shape may join by name (see Shell). */
export type ShellLayer = "base" | "sidebar" | "stage";

/** Group names of the shell's layer surfaces. */
export const shellGroups = { sidebar: "shell-sidebar", stage: "shell-stage" } as const;

type Radius = number | [number, number, number, number];

const radiusAttr = (r: Radius | undefined) =>
  r === undefined ? undefined : Array.isArray(r) ? r.join(" ") : String(r);

const GroupContext = createContext<string>();

/** `relative` unless the author already positioned the element: two position
 * utilities on one element resolve by stylesheet order, not class order. */
const positioned = (cls: string | undefined) =>
  /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(cls ?? "") ? (cls ?? "") : `relative ${cls ?? ""}`;

export interface SurfaceProps {
  material: Material;
  /** The plate's corner radius (1 or 4 values, tl tr br bl). */
  radius?: Radius;
  /** Default fillet radius between this surface's shapes. */
  join?: number;
  /** Light direction, degrees clockwise from straight up. */
  light?: number;
  /** Set false when only the Union/Subtract children make the shape. */
  plate?: boolean;
  /** Fixed group name; the shell uses this for its layers. */
  group?: string;
  /** The plate animates when its own box moves (not on window resize). */
  animate?: boolean;
  id?: string;
  class?: string;
  style?: string;
  children?: JSX.Element;
}

function SurfaceRoot(props: SurfaceProps): JSX.Element {
  const group = props.group ?? `surface-${createUniqueId()}`;
  const look = (): MaterialLook => materials[props.material];
  return (
    <div
      id={props.id}
      class={`isolate ${positioned(props.class)}`}
      style={props.style}
      surface-groups={props.plate === false ? undefined : group}
      surface-radius={radiusAttr(props.radius)}
      surface-animate={props.animate ? true : undefined}
    >
      {/* Below every child of the root (the root is its own stacking context). */}
      <tk-surface
        group={group}
        class="absolute inset-0 -z-10"
        fill={look().fill}
        bevel={look().bevel}
        join={props.join}
        light={props.light}
        elevation={look().recessed ? "recessed" : undefined}
        border={look().border}
        border-mix={look().borderStrength}
        border-lit={look().borderLight}
      />
      <GroupContext.Provider value={group}>{props.children}</GroupContext.Provider>
    </div>
  );
}

export interface ShapeProps {
  radius?: Radius;
  /** Fillet with the shapes already there (CSG join; exact at 90 degrees). */
  join?: number;
  /** Subtract only: cut the shape grown by `gap`, keep the shape as an island. */
  gap?: number;
  /** Lean of the sides, degrees from vertical (one value or [left, right]).
   * Positive leans outward towards the top (the wide end meets the edge it
   * hangs from); joins at the wide end are exact arcs at any angle. */
  slant?: number | [number, number];
  /** Animate when this shape's box moves (window resizes never animate). */
  animate?: boolean;
  /** Union only: this side of the shape meets a vertical edge of another
   * union shape of the same surface (a rail tab against its container). The
   * shape becomes one exact outline with the join as concave fillets where
   * its top and bottom meet that edge; level with the other shape's top (or
   * bottom) its edge runs straight into it, no step. */
  attach?: "left" | "right";
  /** Join a shell layer instead of the nearest Surface. */
  layer?: ShellLayer;
  id?: string;
  class?: string;
  style?: string;
  children?: JSX.Element;
}

function shape(op: "union" | "subtract") {
  return (props: ShapeProps): JSX.Element => {
    const local = useContext(GroupContext);
    const [own, rest] = splitProps(props, [
      "radius",
      "join",
      "gap",
      "slant",
      "animate",
      "attach",
      "layer",
    ]);
    if (!local && !own.layer) {
      throw new Error("Surface shapes must be inside a Surface or name a layer");
    }
    // A shape of base material cuts the shell layers above the base.
    const groups = () =>
      own.layer === "base"
        ? `${shellGroups.sidebar} ${shellGroups.stage}`
        : own.layer
          ? shellGroups[own.layer]
          : local;
    const opFor = () => (own.layer === "base" ? "subtract" : op);
    const slant = () =>
      own.slant === undefined
        ? undefined
        : Array.isArray(own.slant)
          ? own.slant.join(" ")
          : String(own.slant);
    return (
      <div
        id={rest.id}
        class={positioned(rest.class)}
        style={rest.style}
        surface-groups={groups()}
        surface-op={opFor()}
        surface-radius={radiusAttr(own.radius)}
        surface-join={own.join}
        surface-gap={own.gap}
        surface-slant={slant()}
        surface-animate={own.animate ? true : undefined}
        surface-attach={own.attach}
      >
        {rest.children}
      </div>
    );
  };
}

/** A surface with `Surface.Union` and `Surface.Subtract` shapes. */
export const Surface = Object.assign(SurfaceRoot, {
  Union: shape("union"),
  Subtract: shape("subtract"),
});
