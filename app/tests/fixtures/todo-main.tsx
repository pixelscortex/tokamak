/** Standalone native regressions still own a legacy raw-bundle connection. The
 * installed plugin uses the shell's client instead; only this harness mounts. */
import { mount } from "@tokamak/render";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient, type Request, type Event } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import { onCleanup } from "solid-js";
import Todos from "./todos";
mount(() => {
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const client = new TokamakClient(transport);
  onCleanup(() => transport.close());
  return (
    <ClientContext.Provider value={client}>
      <Todos />
    </ClientContext.Provider>
  );
});
