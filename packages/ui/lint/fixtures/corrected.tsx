import { Button } from "@tokamak/ui";

export const Corrected = () => (
  <div class="flex flex-col gap-3">
    <p class="mt-3 text-label text-ink-3">Saved 09:14</p>
    <div class="flex gap-4 text-row text-ink">Weekly admin</div>
    <Button variant="brand" class="mt-4 w-full">
      Merge
    </Button>
    <div class="rounded-lg bg-tray p-1">
      <div class="rounded-md bg-card p-3 text-row text-ink">Finance asked for monthly exports.</div>
      <div class="flex rounded-md p-1">
        <Button>Open</Button>
      </div>
    </div>
  </div>
);
