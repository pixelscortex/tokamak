import { mount, onHostEvent } from "@tokamak/render";
import { createMemoryRouter } from "../js/router";

mount(() => {
  const router = createMemoryRouter("/threads");
  onHostEvent<{ action: string; path?: string }>("route", (event) => {
    if (event.action === "back") router.back();
    else if (event.action === "forward") router.forward();
    else router.navigate(event.path!, { replace: event.action === "replace" });
  });
  return (
    <main>
      <p id="location">{router.location().href}</p>
      <p id="thread">{router.match("/threads/:id")?.params.id ?? "none"}</p>
    </main>
  );
});
