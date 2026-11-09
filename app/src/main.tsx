/** Only the shell mounts a document. Plugin factories receive these exact host
 * module objects, so Solid owners, renderer IDs and SDK context cannot split. */
import * as solid from "solid-js";
import * as universal from "solid-js/universal";
import * as render from "@tokamak/render";
import * as sdk from "@tokamak/sdk";
import * as sdkSolid from "@tokamak/sdk/solid";
import * as ui from "@tokamak/ui";
import * as components from "@tokamak/ui/components";
import * as router from "@tokamak/runtime/router";
import { ModuleRegistry } from "@tokamak/runtime/modules";
import { Shell } from "./shell";

const modules = new ModuleRegistry();
const { mount, ...pluginRenderer } = render;
for (const [name, exports] of Object.entries({
  "solid-js": solid,
  "solid-js/universal": universal,
  "@tokamak/render": pluginRenderer,
  "@tokamak/sdk": sdk,
  "@tokamak/sdk/solid": sdkSolid,
  "@tokamak/ui": ui,
  "@tokamak/ui/elements": ui,
  "@tokamak/ui/components": components,
  "@tokamak/runtime/router": router,
})) modules.provide(name, exports);
mount(() => <Shell modules={modules} />);
