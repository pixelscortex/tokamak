import { flush } from "solid-js";
import { expect, test, vi } from "vitest";
import { createWindowState, windowStateStorage } from "../../window-state-host";
import type { JsonValue } from "../../src/index";

test("edits made before kept state loads are saved on top of the stored value", async () => {
  let finishRead!: (value: JsonValue) => void;
  const pendingRead = new Promise<JsonValue>((resolve) => (finishRead = resolve));
  const saves: JsonValue[] = [];
  const scope = createWindowState(
    windowStateStorage("notes", "workspace", {
      query: () => pendingRead,
      async mutation(_name, args) {
        saves.push(args);
        return null;
      },
    }),
  );
  const pins = scope.state<string[]>("pins", [], { keep: "me" });

  pins.set((previous) => [...previous, "first"]);
  pins.set((previous) => [...previous, "second"]);
  flush();
  expect(pins()).toEqual(["first", "second"]);
  expect(saves).toEqual([]);

  finishRead({ value: ["saved"] });
  await vi.waitFor(() =>
    expect(saves).toEqual([expect.objectContaining({ value: ["saved", "first", "second"] })]),
  );
  flush();
  expect(pins()).toEqual(["saved", "first", "second"]);
});

test("unsaved edits survive a failed load and stay marked until the retry saves them", async () => {
  vi.useFakeTimers();
  const report = vi.fn();
  let finishSave!: (value: JsonValue) => void;
  const pendingSave = new Promise<JsonValue>((resolve) => (finishSave = resolve));
  const query = vi
    .fn<() => Promise<JsonValue>>()
    .mockRejectedValueOnce(new Error("Temporary disconnect"))
    .mockResolvedValue({ value: ["saved"] });
  const mutation = vi.fn(() => pendingSave);
  const scope = createWindowState({
    ...windowStateStorage("notes", "workspace", { query, mutation }),
    report,
  });
  try {
    const pins = scope.state<string[]>("pins", [], { keep: "me" });
    pins.set((previous) => [...previous, "early"]);
    await vi.advanceTimersByTimeAsync(0);
    pins.set((previous) => [...previous, "during retry"]);
    flush();
    expect(scope.hasUnsavedChanges()).toBe(true);
    expect(mutation).not.toHaveBeenCalled();

    await vi.advanceTimersToNextTimerAsync();
    flush();
    expect(pins()).toEqual(["saved", "early", "during retry"]);
    expect(mutation).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ value: pins() }));
    expect(scope.hasUnsavedChanges()).toBe(true);

    finishSave(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(scope.hasUnsavedChanges()).toBe(false);
  } finally {
    scope.dispose();
    vi.useRealTimers();
  }
});
