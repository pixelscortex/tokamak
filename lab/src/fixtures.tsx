/** Unlisted interaction fixture, opened through the lab-test host event. */
import { createSignal } from "solid-js";
import { Shell } from "@tokamak/ui/components";

export default function FixturesView() {
  const [picked, setPicked] = createSignal(false);
  return (
    <Shell.Stage>
      <div id="lab-fixtures" class="flex p-8">
        <button
          id="lab-fixture-toggle"
          aria-pressed={picked()}
          onClick={() => setPicked(!picked())}
          type="button"
          class="flex items-center rounded-md border-0 bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 active:bg-blue-700 aria-pressed:bg-blue-700"
        >
          Toggle
        </button>
      </div>
    </Shell.Stage>
  );
}
