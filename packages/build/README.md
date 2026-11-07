# Internal native build integration

`@tokamak/build` is private workspace tooling, not a published compiler,
customer-configurable plugin framework, product CLI, or runtime dependency.

The sole application uses:

```ts
import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";

export default defineConfig({ plugins: [tokamak()] });
```

There are no options. The conventions are `src/main.tsx`, `src/styles.css`, and
the explicit SDK discovery root `backend/`, relative to the app's Vite config.
Both `moon run app:bundle` from app cwd and
`bun x --no-install vite build --config app/vite.config.ts` from workspace cwd
use that same application. Browser serving/HMR is not supported.

Vite and the maintained Solid plugin own TSX compilation, production-client
selection, universal output, bundling, and frontend maps. The existing SDK task
runs through pinned Bun to check and bundle backend functions; no Node/browser
ambient types enter that backend check. Tailwind compiles shared UI design tokens
into the generated native HTML document. Blitz receives that real document and
the universal bundle, not a fake browser DOM.

Outputs under app `dist/` are `ui.js`, its original map, `bundle.js`, its rebased
original map, and `shell.html`. SDK-generated references and intermediate output
remain under `backend/_generated/` and `backend/dist/`. None are source files.

The internal `/native` and `/css` helpers also support package fixtures and UI
packaging. Renderer/UI compatibility entries delegate here, so typed and spaced
checkout fixtures retain the same compiler, guards, and map composition as the
application. These helpers do not add options to `tokamak()`.
