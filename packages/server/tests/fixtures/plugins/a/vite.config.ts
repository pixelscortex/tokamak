import "../setup.mjs";
import { tokamak } from "../../../../../build/src/vite.ts";
export default {
  plugins: [
    tokamak({
      ui: false,
      plugin: {
        id: "a",
        version: "1.0.0",
        exports: "./api.ts",
        depends: { b: "^1" },
        provides: ["cycle"],
      },
    }),
  ],
};
