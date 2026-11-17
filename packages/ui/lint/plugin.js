// Tokamak's own lint rules, in the ESLint plugin format (Oxlint loads it as a
// JS plugin). concentric-radius: inside a rounded parent, a rounded child's
// radius equals the parent's radius minus the parent's padding. It applies
// when the child sits inside the corner's curve (padding < outer radius).

const radii = { none: 0, xs: 4, sm: 8, md: 12, lg: 16 };
const nameOf = Object.fromEntries(Object.entries(radii).map(([name, px]) => [px, name]));
const spacing = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 };
const stepOf = Object.fromEntries(Object.entries(spacing).map(([step, px]) => [px, step]));

// Primitives that draw their own surface: [radius, padding to their children].
export const primitiveShapes = {
  Button: [8, null],
  MenuTrigger: [8, null],
  DialogTrigger: [8, null],
  DialogClose: [8, null],
  TooltipTrigger: [8, null],
  SelectTrigger: [8, null],
  Chip: [8, null],
  Row: [8, null],
  RowOption: [8, null],
  Textarea: [8, null],
  TabsTab: [8, null],
  MenuContent: [12, 4],
  SelectContent: [12, 4],
  DialogContent: [16, 24],
};

function staticClass(element) {
  for (const attribute of element.openingElement.attributes) {
    if (attribute.type !== "JSXAttribute") continue;
    const name = attribute.name.name;
    if (name !== "class" && name !== "className") continue;
    const value = attribute.value;
    if (!value) return "";
    if (value.type === "Literal" && typeof value.value === "string") return value.value;
    if (value.type === "JSXExpressionContainer") {
      const expression = value.expression;
      if (expression.type === "Literal" && typeof expression.value === "string") return expression.value;
      if (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
        return expression.quasis[0].value.cooked;
    }
    return undefined;
  }
  return "";
}

function elementName(element) {
  const name = element.openingElement.name;
  return name.type === "JSXIdentifier" ? name.name : undefined;
}

// Reads the base classes (no variants such as hover: or md:) that matter here.
function shape(element) {
  const classes = staticClass(element);
  const name = elementName(element);
  const primitive = name ? primitiveShapes[name] : undefined;
  if (classes === undefined) return undefined;
  const result = {
    radius: primitive ? primitive[0] : 0,
    radiusClass: undefined,
    padding: primitive ? primitive[1] : 0,
    paints: Boolean(primitive),
    clips: false,
    primitive: Boolean(primitive) && name,
  };
  let px;
  let py;
  for (const token of classes.split(/\s+/)) {
    if (!token || token.includes(":")) continue;
    let match;
    if ((match = /^rounded(?:-(none|xs|sm|md|lg|full))?$/.exec(token))) {
      const key = match[1] ?? "sm";
      result.radius = key === "full" ? Infinity : radii[key];
      result.radiusClass = token;
    } else if ((match = /^p-(\d+)$/.exec(token)) && match[1] in spacing) result.padding = spacing[match[1]];
    else if ((match = /^px-(\d+)$/.exec(token)) && match[1] in spacing) px = spacing[match[1]];
    else if ((match = /^py-(\d+)$/.exec(token)) && match[1] in spacing) py = spacing[match[1]];
    else if (token.startsWith("bg-") && token !== "bg-transparent") result.paints = true;
    else if (/^overflow-(hidden|clip)$/.test(token)) result.clips = true;
  }
  if (px !== undefined || py !== undefined) result.padding = px === py ? px : null;
  return result;
}

function describe(px) {
  return px === 0 ? "square (no rounded-* class)" : `rounded-${nameOf[px]} (${px} px)`;
}

const concentricRadius = {
  meta: {
    type: "suggestion",
    docs: { description: "Nested corners stay concentric: inner radius = outer radius − padding." },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(parent) {
        const outer = shape(parent);
        if (!outer || !outer.radius || outer.radius === Infinity || outer.padding === null) return;
        for (const child of parent.children) {
          if (child.type !== "JSXElement") continue;
          const inner = shape(child);
          if (!inner || !inner.paints || inner.radius === Infinity) continue;
          if (outer.padding === 0 && outer.clips) continue;
          // A child further from the edge than the corner is deep sits clear of
          // the curve, like a button in a dialog's body: nothing to align.
          if (outer.padding >= outer.radius) continue;
          const expected = Math.max(0, outer.radius - outer.padding);
          if (inner.radius === expected) continue;
          const where = `inside a ${outer.radius} px corner with ${outer.padding} px padding`;
          let advice;
          if (inner.primitive) {
            const parentRadius = inner.radius + outer.padding;
            const padding = outer.radius - inner.radius;
            const options = [];
            if (nameOf[parentRadius] !== undefined)
              options.push(`give the parent rounded-${nameOf[parentRadius]}`);
            if (padding >= 0 && stepOf[padding] !== undefined)
              options.push(`give the parent p-${stepOf[padding]}`);
            advice = `<${inner.primitive}> has a fixed ${inner.radius} px radius, so ${
              options.length ? options.join(" or ") : "drop the parent's rounding"
            }.`;
          } else {
            advice = `Use ${describe(expected)} here.`;
          }
          context.report({
            node: child.openingElement,
            message: `Corner is not concentric: ${describe(inner.radius)} ${where} should be ${describe(
              expected,
            )}, because inner radius = outer radius − the gap. ${advice}`,
          });
        }
      },
    };
  },
};

export const plugin = {
  meta: { name: "tokamak" },
  rules: { "concentric-radius": concentricRadius },
};

export default plugin;
