import { definePlugin } from "@tokamak/sdk";
export default definePlugin({
  id: "composer-mod",
  version: "0.1.0",
  name: "Composer mod",
  description: "Composer extension fixture.",
  depends: ["chat"],
  permissions: [],
});
