import { view } from "@tokamak/sdk/client";
import { Button } from "@tokamak/ui";

export const OutsideView = view({ route: "/outside" }, () => (
  <section class="bg-brand">
    <Button>Notes</Button>
  </section>
));
