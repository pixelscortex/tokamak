// Tokamak's own lint rules, in the ESLint plugin format (Oxlint loads it as a
// JS plugin).
// concentric-radius: inside a rounded parent, a rounded child's radius equals
// max(0, parent radius − parent padding). It applies when the child sits
// inside the corner's curve (padding < outer radius). nest-*/rounded-inner
// are concentric by construction.
// density-inward: a density-* region inside a tighter one is an error.

const radii = { none: 0, xs: 4, sm: 8, md: 12, lg: 16 };
const nameOf = Object.fromEntries(Object.entries(radii).map(([name, px]) => [px, name]));
const spacing = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 };
const stepOf = Object.fromEntries(Object.entries(spacing).map(([step, px]) => [px, step]));

// Primitives that draw their own surface: [radius, padding to their children].
// tests/lint.test.ts checks these against the primitives' own classes.
export const primitiveShapes = {
  Button: [8, null],
  "Menu.Trigger": [8, null],
  "Dialog.Trigger": [8, null],
  "Dialog.Close": [8, null],
  "Tooltip.Trigger": [8, null],
  "Select.Trigger": [8, null],
  Chip: [8, null],
  Row: [8, null],
  "RowList.Option": [8, null],
  Textarea: [8, null],
  "Tabs.Tab": [8, null],
  "Command.Item": [8, null],
  "Menu.RadioItem": [8, null],
  "Collapsible.Trigger": [8, null],
  CodeBlock: [12, 4],
  "Menu.Content": [12, 4],
  "Select.Content": [12, 4],
  "Dialog.Content": [16, 24],
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
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression" && name.object.type === "JSXIdentifier")
    return `${name.object.name}.${name.property.name}`;
  return undefined;
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
    inner: false,
  };
  let px;
  let py;
  for (const token of classes.split(/\s+/)) {
    if (!token || token.includes(":")) continue;
    let match;
    if (token === "rounded-inner") result.inner = true;
    else if ((match = /^nest-(xs|sm|md|lg)(?:\/(\d+))?$/.exec(token))) {
      result.radius = radii[match[1]];
      result.padding = spacing[match[2] ?? 0] ?? null;
    } else if ((match = /^rounded(?:-(none|xs|sm|md|lg|full))?$/.exec(token))) {
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
          if (!inner || inner.inner || !inner.paints || inner.radius === Infinity) continue;
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

const tightness = { roomy: 0, normal: 1, dense: 2 };

function densityOf(element) {
  const classes = staticClass(element);
  const match = classes && /(?:^|\s)density-(roomy|normal|dense)(?:\s|$)/.exec(classes);
  return match ? match[1] : undefined;
}

const densityInward = {
  meta: {
    type: "problem",
    docs: { description: "Density only gets tighter inward." },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(element) {
        const own = densityOf(element);
        if (!own) return;
        for (let node = element.parent; node; node = node.parent) {
          if (node.type !== "JSXElement") continue;
          const outer = densityOf(node);
          if (!outer) continue;
          if (tightness[own] < tightness[outer])
            context.report({
              node: element.openingElement,
              message: `density-${own} sits inside density-${outer}; density only gets tighter inward. Use density-${outer} or remove it here.`,
            });
          return;
        }
      },
    };
  },
};

export const plugin = {
  meta: { name: "tokamak" },
  rules: { "concentric-radius": concentricRadius, "density-inward": densityInward },
};

export default plugin;
