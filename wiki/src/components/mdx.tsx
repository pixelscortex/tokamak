// MDX components available to every content page. TypeTable renders the
// tables that `<auto-type-table>` compiles from the SDK source at build time.
import defaultMdxComponents from "fumadocs-ui/mdx";
import { TypeTable } from "fumadocs-ui/components/type-table";
import type { MDXComponents } from "mdx/types";

export default {
  ...defaultMdxComponents,
  TypeTable,
} satisfies MDXComponents;
