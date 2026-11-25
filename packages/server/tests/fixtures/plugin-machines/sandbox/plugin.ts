import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "sandbox-test",
  name: "Test sandbox",
  version: "1.0.0",
  depends: ["machine-outsider"],
});
