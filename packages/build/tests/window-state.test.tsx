import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { expect, test } from "vitest";
import { Row } from "./fixtures/window-plugin/src/main";

test("a named Solid component regains its own state after unloading", () => {
  const root = document.createElement("div");
  const dispose = render(() => <Row />, root);
  const buttons = () => Array.from(root.querySelectorAll("button"));
  const labels = () => buttons().map((button) => button.textContent);
  const click = (index: number) => {
    buttons()[index]!.click();
    flush();
  };
  try {
    click(1);
    click(1);
    click(0);
    expect(labels()).toEqual(["Toggle left", "Right: 0, empty"]);
    click(1);
    click(0);
    expect(labels()).toEqual(["Toggle left", "Left: 2, edited", "Right: 1, edited"]);
  } finally {
    dispose();
  }
});
