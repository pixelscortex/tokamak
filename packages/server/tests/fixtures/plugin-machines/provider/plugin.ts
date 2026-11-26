import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "machine-provider",
  version: "1.0.0",
  optional: ["machine-outsider"],
});
