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

function classValue(element) {
  const attribute = element.openingElement.attributes.find(
    (attr) => attr.type === "JSXAttribute" && (attr.name.name === "class" || attr.name.name === "className"),
  );
  return attribute?.value;
}

function staticClass(element) {
  const value = classValue(element);
  if (!value) return "";
  const expression = value.type === "JSXExpressionContainer" ? value.expression : value;
  if (expression.type === "Literal" && typeof expression.value === "string") return expression.value;
  if (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
    return expression.quasis[0].value.cooked;
  return undefined;
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

function utility(token) {
  // Variants can contain colons inside selectors, and arbitrary values can
  // contain colons too. Only a colon outside brackets separates the utility.
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}

function* templateStrings({ quasis, expressions }) {
  for (const [index, quasi] of quasis.entries()) {
    const text = quasi.value.cooked ?? "";
    // Only take whole utilities, not pieces joined to a dynamic value.
    const start = index > 0 ? text.replace(/^\S+/, "") : text;
    yield index < expressions.length ? start.replace(/\S+$/, "") : start;
    if (index === expressions.length) continue;
    const next = quasis[index + 1].value.cooked ?? "";
    if (
      (/\s$/.test(text) || (index === 0 && !text)) &&
      (/^\s/.test(next) || (!next && index + 1 === expressions.length))
    )
      yield* classStrings(expressions[index]);
  }
}

function properties(node) {
  return node?.type === "ObjectExpression" ? node.properties.filter((prop) => prop.type === "Property") : [];
}

function keyOf(prop) {
  return prop.key.type === "Literal" ? prop.key.value : !prop.computed ? prop.key.name : undefined;
}

function* styleValues(node) {
  if (node?.type === "ObjectExpression") {
    for (const prop of properties(node)) yield* styleValues(prop.value);
  } else yield* classStrings(node);
}

function* variantStrings(config) {
  for (const prop of properties(config)) {
    const key = keyOf(prop);
    if (key === "base" || key === "slots" || key === "variants") yield* styleValues(prop.value);
    if ((key === "compoundVariants" || key === "compoundSlots") && prop.value.type === "ArrayExpression") {
      for (const entry of prop.value.elements) {
        for (const field of properties(entry)) {
          if (keyOf(field) === "class" || keyOf(field) === "className") yield* styleValues(field.value);
        }
      }
    }
  }
}

function* classStrings(node) {
  switch (node?.type) {
    case "Literal":
      if (typeof node.value === "string") yield node.value;
      break;
    case "JSXExpressionContainer":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      yield* classStrings(node.expression);
      break;
    case "TemplateLiteral":
      yield* templateStrings(node);
      break;
    case "ConditionalExpression":
      yield* classStrings(node.consequent);
      yield* classStrings(node.alternate);
      break;
    case "LogicalExpression":
      if (node.operator !== "&&") yield* classStrings(node.left);
      yield* classStrings(node.right);
      break;
    case "ArrayExpression":
      for (const entry of node.elements) yield* classStrings(entry);
      break;
    case "SpreadElement":
      yield* classStrings(node.argument);
      break;
    case "ObjectExpression":
      for (const prop of properties(node)) {
        const key = keyOf(prop);
        if (typeof key === "string") yield key;
      }
      break;
    case "CallExpression":
      yield* callStrings(node);
      break;
  }
}

function* callStrings({ callee, arguments: args }) {
  if (callee.type === "Identifier" && callee.name === "cn") {
    for (const arg of args) yield* classStrings(arg);
  } else if (callee.type === "Identifier" && callee.name === "tv") {
    yield* variantStrings(args[0]);
  } else if (callee.type === "CallExpression") {
    yield* callStrings(callee);
  } else if (callee.type === "MemberExpression" && callee.object.type === "CallExpression") {
    yield* callStrings(callee.object);
  }
}

function matchingClass(element, matches) {
  for (const classes of classStrings(classValue(element))) {
    const token = classes.split(/\s+/).find((part) => matches(utility(part)));
    if (token) return token;
  }
}

const noNegativeMargin = {
  meta: {
    type: "problem",
    docs: { description: "Use size, density or layout instead of negative margins." },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(element) {
        const token = matchingClass(element, (name) => /^-m[xysetrbl]?-/.test(name));
        if (token)
          context.report({
            node: element.openingElement,
            message: `"${token}" is a negative margin. Use a size or density, or gap on the parent.`,
          });
      },
    };
  },
};

const noRawButton = {
  meta: {
    type: "problem",
    docs: { description: "Use the shared button or row primitive." },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(element) {
        if (elementName(element) === "button")
          context.report({
            node: element.openingElement,
            message: 'Use Button from @tokamak/ui, or Row with as="button" for list rows.',
          });
      },
    };
  },
};

const buttonLooks = new Set([
  "Button",
  "Menu.Trigger",
  "Dialog.Trigger",
  "Dialog.Close",
  "Tooltip.Trigger",
  "Select.Trigger",
]);
const textLayout =
  /^text-(?:start|end|left|right|center|justify|wrap|nowrap|balance|pretty|ellipsis|clip|trim)$/;
const textStyle =
  /^(?:(?:text|font|tracking|leading)-|(?:uppercase|lowercase|capitalize|italic|underline|line-through)$)/;

function leadOwner(attribute) {
  const owner = attribute.parent?.parent;
  if (attribute.name.name !== "lead" || owner?.type !== "JSXElement") return undefined;
  const name = elementName(owner);
  return buttonLooks.has(name) ? name : undefined;
}

function buttonAncestor(element) {
  for (let node = element.parent; node; node = node.parent) {
    // Only the lead prop renders inside the button, beside its children.
    if (node.type === "JSXAttribute") return leadOwner(node);
    if (node.type === "JSXSpreadAttribute") return undefined;
    if (node.type !== "JSXElement") continue;
    const name = elementName(node);
    if (buttonLooks.has(name)) return name;
  }
  return undefined;
}

const noTextStyleInButton = {
  meta: {
    type: "problem",
    docs: {
      description: "Button labels and leads inherit typography and tone; Row buttons have their own slots.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(element) {
        const token = matchingClass(element, (name) => textStyle.test(name) && !textLayout.test(name));
        if (!token) return;
        const button = buttonAncestor(element);
        if (button)
          context.report({
            node: element.openingElement,
            message: `<${button}> owns its text size, weight and tone. Remove "${token}" and let the text inherit.`,
          });
      },
    };
  },
};

export const plugin = {
  meta: { name: "tokamak" },
  rules: {
    "concentric-radius": concentricRadius,
    "density-inward": densityInward,
    "no-negative-margin": noNegativeMargin,
    "no-raw-button": noRawButton,
    "no-text-style-in-button": noTextStyleInButton,
  },
};

export default plugin;
