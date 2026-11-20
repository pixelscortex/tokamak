import { view } from "@tokamak/sdk/client";
import { Button } from "@tokamak/ui";

export const OutsideView = view({ route: "/outside" }, () => (
  <section class="print:p-3">
    <Button>Notes</Button>
  </section>
));
