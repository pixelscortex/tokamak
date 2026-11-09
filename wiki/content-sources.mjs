// Package docs stay beside their code. Only site metadata belongs here.
export const contentSources = [
  {
    source: "packages/server/HOW_IT_WORKS.md",
    page: "how-it-works.md",
    title: "How Tokamak works",
    description: "From a desktop click to the database and back: runtime, plugins and live queries.",
  },
  {
    source: "packages/server/README.md",
    page: "server/index.md",
    title: "Server",
    description: "The server CLI, local mode, lifecycle and delivery contract.",
  },
  {
    source: "packages/server/PLUGINS.md",
    page: "server/plugins.md",
    title: "Plugin installation",
    description: "Build and run, loading and reload, calls, data ownership and capabilities.",
  },
  {
    source: "packages/server/src/data/README.md",
    page: "server/store.md",
    title: "Store boundary",
    description: "The storage facade: plugin data spaces and reactive dependencies.",
  },
  {
    source: "packages/runtime/ROUTING.md",
    page: "runtime/routing.md",
    title: "Routing",
    description: "Window routing and the memory router in @tokamak/runtime/router.",
  },
  {
    source: "packages/runtime/PLUGINS.md",
    page: "runtime/plugins.md",
    title: "Client plugins",
    description: "The desktop plugin loader and UI integration.",
    optional: true,
  },
  {
    source: "packages/engine/WEB_APIS.md",
    page: "engine/web-apis.md",
    title: "Web APIs",
    description: "The web APIs available to backend actions.",
    optional: true,
  },
];

/** @param {string} page */
export function pageUrl(page) {
  return `/docs/${page.replace(/\.(md|mdx)$/, "").replace(/\/?index$/, "")}`.replace(/\/$/, "");
}
