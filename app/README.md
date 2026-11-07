# Desktop application

This is the single application composition root. The built-in Todo will be
implemented directly here using `@tokamak/sdk` and `@tokamak/ui`, through the
same function/subscription path intended for future first-class plugins.

Reusable host and UI packages live in `packages/`. Root `plugins/` is reserved
for future plugins and is not scaffolded. This application has no source entry
point or executable yet; package demos remain package-owned validation fixtures.
