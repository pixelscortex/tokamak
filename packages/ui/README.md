# @tokamak/ui

Tokamak's Solid 2 primitives and Tailwind tokens. The rules are in the wiki's
design page (`wiki/content/docs/design/index.mdx`).

- `@tokamak/ui`: the primitives. Each source file starts with a comment that
  shows how to use it.
- `@tokamak/ui/theme.css`: the tokens (colours, type sizes, radii) as a
  Tailwind `@theme`.
- `@tokamak/ui/kit`: the app's `/kit` page, which draws every token and
  primitive in every state, in both themes.
- `@tokamak/ui/lint`: the lint rules that keep plugins on the primitives.

Primitives are built on `@ui-sdk/solid`. Single elements:

- `Avatar`, `Chip`, `CodeBlock`, `FileName`, `Icon`, `Kbd`, `Row`,
  `ScrollArea`, `StatusIcon`, `Textarea`
- `Button`: `sm` 24, `md` 32 (default) or `lg` 48 tall
- `Input`: one line; `md` 40 or `lg` 48 tall, radius 12; `mono`, `invalid`,
  a leading `icon` and a `trail` action
- `Switch`: 28 × 16, on or off; toggles with click, Space and Enter

Namespaces (several parts): `Collapsible`, `Command`, `Dialog`, `Menu`,
`Resizable`, `RowList`, `Select`, `Tabs`, `Tooltip`.
