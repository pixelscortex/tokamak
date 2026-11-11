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
 * Plates: for pieces that are each one plate (keycaps, trays, chips), a
 * plain element with a solid background colour or a `material-*` utility
 * (materials.css) inside a region paints its own fill and lit edge, at its
 * own place in paint order, no component needed:
 *
 *   <button class="bg-blue-600 bevel-2 rounded-md px-3 active:recessed">Run</button>
 *   <button class="material-key active:material-key-pressed rounded-[7px] px-3">Deny</button>
 *
 * Every shell region, every `Surface` and every `Sheet` is a region.
 * `plates="sheet"` on one makes its materials layer draw all of its plates
 * in one pass below its content instead (see `PlatePainter`).
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
  // The big shell surfaces have no bevel band: their edge is the hairline
  // alone, one crisp pixel that follows the fused outline.
  base: { fill: "var(--color-base)", bevel: 0 },
  sidebar: { fill: "var(--color-sidebar)", bevel: 0, ...hairline },
  panel: { fill: "var(--color-panel)", bevel: 0, ...hairline },
  card: { fill: "var(--color-card)", bevel: 1 },
  chip: { fill: "var(--color-chip)", bevel: 1 },
  well: { fill: "var(--color-well)", bevel: 1, recessed: true },
} satisfies Record<string, MaterialLook>;

export type Material = keyof typeof materials;

/** Shell layers a shape may join by name (see Shell). */
export type ShellLayer = "base" | "sidebar" | "stage";

/** Group names of the shell's layer surfaces. */
export const shellGroups = { sidebar: "shell-sidebar", stage: "shell-stage" } as const;

type Radius = number | [number, number, number, number];

/** Who draws the plates of a region (render/SURFACES.md, "Plates").
 * - `"self"` (the default): each plate paints itself, as part of its own
 *   element. It covers what its element covers and follows the element's
 *   z-index, the opacity and transforms of its ancestors, and the clip of
 *   every scroll container around it.
 * - `"sheet"`: one layer below all of the region's content draws every
 *   plate in one shader pass. Choose it for lighting that spreads between
 *   neighbouring plates (one pass sees them all). Its limits: a plate never
 *   covers other content of its region, ignores z-index, ancestor opacity
 *   and transforms, and is clipped only by the region.
 * A nested region decides for its own plates. */
export type PlatePainter = "self" | "sheet";

/** The `tk-region` attribute value for a painter. */
const region = (plates: PlatePainter | undefined) => (plates === "sheet" ? "sheet" : true);

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
  /** Who draws the plates inside this surface (default: each its own). */
  plates?: PlatePainter;
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
      tk-region={region(props.plates)}
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
      {/* The surface's sheet: over the surface, under its content. It draws
        * the plates inside the surface that do not paint themselves (all of
        * them with `plates="sheet"`). Without it those would go to the
        * enclosing region's layer, below this surface, and not show. */}
      <MaterialsLayer />
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
   * union shape of the same surface (a tab against its container). The
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

/** The materials layer ("the sheet") of the element it is placed in
 * (render/SURFACES.md, "Plates"), below all of that element's content. It
 * makes the element a region: the element must carry `tk-region` (so the
 * stylesheet stops Blitz painting the backgrounds of its plates) and be a
 * stacking context (`isolate`) so the layer stays above what is behind the
 * element. The layer draws the region's plates that do not paint
 * themselves: all of them when the region is `tk-region="sheet"`, otherwise
 * only those on elements that cannot carry a widget. Used by the shell
 * regions, `Surface` and `Sheet`, not by views. */
export function MaterialsLayer(): JSX.Element {
  return <tk-surface materials class="absolute inset-0 -z-10" />;
}

export interface SheetProps {
  /** Who draws the plates inside this sheet (default: each its own). */
  plates?: PlatePainter;
  id?: string;
  class?: string;
  style?: string;
  children?: JSX.Element;
}

/** A region of its own, anywhere: a floating piece (a menu, a popover) or a
 * part of a view that chooses who draws its plates. The sheet's own
 * `bg-*` or `material-*` class, if any, is its bottom plate.
 *
 *   <Sheet class="material-card absolute top-10 right-0 rounded-lg p-1">
 *     <button class="hover:material-chip rounded-md px-2">Rename</button>
 *   </Sheet>
 *
 * With `plates="sheet"` its layer draws every plate inside it in one pass
 * (see `PlatePainter`); the sheet and its plates then paint where the sheet
 * sits in the stacking order, all of them below its content. */
export function Sheet(props: SheetProps): JSX.Element {
  return (
    <div id={props.id} tk-region={region(props.plates)} class={`isolate ${positioned(props.class)}`} style={props.style}>
      <MaterialsLayer />
      {props.children}
    </div>
  );
}

/** A surface with `Surface.Union` and `Surface.Subtract` shapes. */
export const Surface = Object.assign(SurfaceRoot, {
  Union: shape("union"),
  Subtract: shape("subtract"),
});
