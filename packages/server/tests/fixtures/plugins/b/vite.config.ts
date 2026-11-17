import "../setup.mjs";
import { tokamak } from "../../../../../build/src/vite.ts";
export default {
  plugins: [
    tokamak({
      ui: false,
      plugin: {
        id: "b",
        version: "1.0.0",
        exports: "./api.ts",
        consumes: ["cycle"],
        provides: ["cycle"],
      },
    }),
  ],
};
