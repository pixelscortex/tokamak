import { definePlugin } from "@tokamak/sdk";
export default definePlugin({
  id: "acp",
  version: "0.1.0",
  name: "ACP",
  description: "Agent Client Protocol chat backend.",
  depends: ["chat"],
  permissions: ["acp"],
});
