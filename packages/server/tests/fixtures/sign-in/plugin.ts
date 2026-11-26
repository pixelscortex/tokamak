import { definePlugin } from "@tokamak/sdk";

// A password sign-in method for Tokamak's own tests. It fills the `auth.method`
// contract with the same forms as the real password plugin, so the sign-in
// routes, the owner setup, members and the app's sign-in dialog can be tested
// with no real plugin installed.
export default definePlugin({
  id: "fixture-sign-in",
  version: "1.0.0",
  name: "Password",
  description: "Test sign-in with a username or email and password.",
  depends: ["auth"],
  permissions: [],
});
