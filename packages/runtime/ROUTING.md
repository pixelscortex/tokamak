# Window routing

The window's shell owns the route tree and history. A plugin adds a page by
exporting a view with a literal route from its window API:

```tsx
import { view } from "@tokamak/sdk/client";

export const Notes = view({ route: "/", title: "Notes" }, () => <main>Notes</main>);
```

The build records the page in the plugin manifest so the shell can discover it
before loading the page. The shell prefixes each route with
`/p/<plugin-id>`. For example, the root page of `notes` opens at `/p/notes`,
and a page at `/archive` opens at `/p/notes/archive`.

The runtime exports `createMemoryRouter` for an independent history and
`matchRoute` for matching a pathname against a pattern. Patterns can include
segments such as `:id` and a terminal splat such as `*path`. Query and fragment
strings are kept on the location, separate from the pathname. Each independent
history can navigate, go back, and go forward without changing another history.

See [Client plugins](PLUGINS.md) for page loading and reload behavior.
