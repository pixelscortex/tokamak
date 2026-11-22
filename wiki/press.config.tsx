import { sourceRepository } from "./src/lib/source-repository";
import { createPress, recommendedPreset } from "fumapress";
import { metaSchema, pageSchema } from "fumapress/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { createGenerator, remarkAutoTypeTable } from "fumadocs-typescript";
import { remarkSourceLinks } from "./src/lib/remark-source-links";
import { remarkApiDeclaration } from "./src/lib/remark-api-declaration";

// Reads the SDK's TypeScript source at build time, so the API reference always
// matches packages/sdk. No cache: a stale table is worse than a slower build.
const generator = createGenerator();

const docs = defineDocs({
  dir: ".generated/docs",
  docs: {
    async: true,
    schema: pageSchema,
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
    // A collection-level mdxOptions replaces the defaults, so re-apply the preset.
    mdxOptions: applyMdxPreset({
      // Declarations become code blocks before the defaults run, so the
      // Markdown output and search see them like any other code block.
      remarkPlugins: (plugins) => [
        remarkSourceLinks,
        [remarkApiDeclaration, { generator }],
        ...plugins,
        [remarkAutoTypeTable, { generator }],
      ],
    }),
  },
  meta: {
    schema: metaSchema,
  },
});

// Content lives under /docs so the landing page can own /.
export const app = createPress(docs.toFumadocsSource({ baseDir: "docs" }));

export default app.config({
  // Social images need a native addon that Bun's isolated install does not
  // expose to the bundle, and a local docs site has no use for them. No blog, no RSS.
  preset: recommendedPreset({ ogImage: false, rss: false }),
  site: {
    name: "Tokamak",
    // Set when the site is deployed; sitemap URLs stay relative until then.
    // baseUrl: "https://example.com",
  },
  ui: {
    // Light theme only, so there is no theme switch.
    providerProps: { theme: { forcedTheme: "light", enableSystem: false } },
    layoutProps: {
      ...(sourceRepository && { githubUrl: `https://github.com/${sourceRepository}` }),
      themeSwitch: { enabled: false },
    },
  },
  head: [
    { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
    { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" } },
    {
      tag: "link",
      attrs: {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap",
      },
    },
  ],
});
