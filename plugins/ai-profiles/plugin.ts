import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "ai-profiles",
  version: "0.1.0",
  name: "AI Profiles",
  description: "The Profiles screen: a person's subscriptions, and later the profiles built from them.",
  depends: ["ai", "agent-proxy"],
  permissions: [],
});
