import { lanes, placedModules } from "./placement.mjs";

export function httpActionEntry(placement, root, organized) {
  const modules = placedModules(placement, root, organized, lanes.http.keep);
  if (!modules.length) return;
  const routes = Object.create(null);
  const shapes = new Set();
  const imports = [];
  const handlers = [];
  for (const [file, , names] of modules) {
    for (const name of names) {
      const { path } = placement.modules.get(file).get(name);
      if (typeof path !== "string")
        throw new Error(`${file}:${name}: HTTP action path must be a string literal`);
      if (Object.hasOwn(routes, path)) throw new Error(`Duplicate HTTP action path: ${path}`);
      const parts = path.slice(1).split("/");
      const shape = parts.map((part) => (part.startsWith(":") ? ":" : part)).join("/");
      if (shapes.has(shape)) throw new Error(`Ambiguous HTTP action path: ${path}`);
      shapes.add(shape);
      if (
        path === "/reload" ||
        (parts.length >= 3 &&
          parts[0] &&
          parts[0] !== "*" &&
          parts[1] === "assets" &&
          (parts.length > 3 || (parts[2] && parts[2] !== "*")))
      )
        throw new Error(`HTTP action path only matches a reserved core route: ${path}`);
      const binding = `route${imports.length}`;
      routes[path] = true;
      imports.push(`import { ${JSON.stringify(name)} as ${binding} } from ${JSON.stringify(file)};`);
      handlers.push(`[${JSON.stringify(path)}]: ${binding}.handler`);
    }
  }
  return {
    modules,
    paths: Object.keys(routes),
    source: imports.join("\n") + `\nexport const handlers = { ${handlers.join(", ")} };\n`,
  };
}
