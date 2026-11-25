import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "ai",
  version: "1.0.0",
  permissions: ["env:FIXTURE_ACTION_PLACEMENT"],
});
