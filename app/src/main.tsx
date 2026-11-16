/** Each evaluation installs local runtime namespaces. Normal loading still
 * shares the shell context; the opt-in realm slice evaluates this bootstrap in
 * each plugin context and supplies services through native call capabilities. */
import * as solid from "solid-js";
import * as universal from "solid-js/universal";
import * as render from "@tokamak/render";
import * as sdk from "@tokamak/sdk";
import * as sdkClient from "@tokamak/sdk/client";
import * as sdkSolid from "@tokamak/sdk/solid";
import * as ui from "@tokamak/ui";
import * as components from "@tokamak/ui/components";
import * as router from "@tokamak/runtime/router";
import { ModuleRegistry } from "@tokamak/runtime/modules";
import { Shell } from "./shell";
import { installRealmEntry, realmProviders } from "@tokamak/runtime/realms";
import { ClientContext } from "@tokamak/sdk/solid";
import { ExtensionProvider, ShortcutContext } from "@tokamak/sdk/client";
import { RouterContext } from "@tokamak/runtime/router";
declare const __tokamakRealmName: string;

const modules = new ModuleRegistry();
const { mount, ...pluginRenderer } = render;
for (const [name, exports] of Object.entries({
  "solid-js": solid,
  "solid-js/universal": universal,
  "@tokamak/render": pluginRenderer,
  "@tokamak/sdk": sdk,
  "@tokamak/sdk/client": sdkClient,
  "@tokamak/sdk/solid": sdkSolid,
  "@tokamak/ui": ui,
  "@tokamak/ui/elements": ui,
  "@tokamak/ui/components": components,
  "@tokamak/runtime/router": router,
}))
  modules.provide(name, exports);
installRealmEntry(modules);
if (__tokamakRealmName) {
  realmProviders(modules, (services, children) => (
    <ClientContext.Provider value={services.client}>
      <RouterContext.Provider value={services.router}>
        <ShortcutContext.Provider value={services.shortcuts}>
          <ExtensionProvider host={services.extensions}>{children()}</ExtensionProvider>
        </ShortcutContext.Provider>
      </RouterContext.Provider>
    </ClientContext.Provider>
  ));
} else mount(() => <Shell modules={modules} />);
