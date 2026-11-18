// Lint config for Tokamak plugin UIs. Oxlint: "extends": ["<path to>/@tokamak/ui/lint/oxlint.json"].
// ESLint (flat config):
//   import { tokamak } from "@tokamak/ui/lint";
//   import tsParser from "@typescript-eslint/parser";
//   export default [tokamak({ files: ["src/client/**/*.tsx"], parser: tsParser })];
import { plugin as shadcn } from "@shadcn/lint";
import { plugin } from "./plugin.js";
import config from "./oxlint.json" with { type: "json" };

export { plugin };
export const rules = config.rules;
export const settings = config.settings;

export function tokamak({ files = ["**/*.{tsx,jsx}"], parser } = {}) {
  return {
    files,
    languageOptions: parser ? { parser, parserOptions: { ecmaFeatures: { jsx: true } } } : {},
    plugins: { shadcn, tokamak: plugin },
    settings,
    rules,
  };
}
