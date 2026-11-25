# @tokamak/ui

Tokamak's Solid 2 primitives, tokens (`@tokamak/ui/theme.css`) and lint
config (`@tokamak/ui/lint`). The rules are in the wiki's design page
(`wiki/content/docs/design/index.mdx`); the app's `/kit` page shows every
token and primitive in both themes. Each primitive's file starts with its
usage and the Paper values it follows.

Primitives are built on `@ui-sdk/solid`. Single elements:

- `Avatar`, `Button`, `Chip`, `CodeBlock`, `FileName`, `Icon`, `Kbd`, `Row`,
  `ScrollArea`, `StatusIcon`, `Textarea`
- `Input`: one line; `md` 40 or `lg` 48 tall, radius 12; `mono`, `invalid`,
  a leading `icon` and a `trail` action
- `Switch`: 28 × 16, on or off; toggles with click, Space and Enter

Namespaces (several parts): `Collapsible`, `Command`, `Dialog`, `Menu`,
`Resizable`, `RowList`, `Select`, `Tabs`, `Tooltip`.
