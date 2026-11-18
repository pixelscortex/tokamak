import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { JSX } from "@solidjs/web";
import { CodeBlock, Collapsible } from "../src/index.ts";
import { primitiveShapes } from "../lint/plugin.js";
import { triggerVariants } from "../src/collapsible.tsx";

function mount(view: () => JSX.Element) {
  return render(view, document.body.appendChild(document.createElement("div")));
}

test("a collapsible trigger opens its panel from the keyboard and reports it", async () => {
  const user = userEvent.setup();
  mount(() => (
    <Collapsible.Root>
      <Collapsible.Trigger trail="12s">Worked</Collapsible.Trigger>
      <Collapsible.Panel>Read session.ts</Collapsible.Panel>
    </Collapsible.Root>
  ));
  const trigger = screen.getByRole("button", { name: /Worked/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Read session.ts")).toBeNull();
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  expect(screen.getByText("Read session.ts")).toBeTruthy();
});

test("a code block copies its code and says so in its name", async () => {
  const user = userEvent.setup();
  const copy = vi.fn(async (_text: string) => {});
  mount(() => <CodeBlock code="bun test" language="sh" copy={copy} />);
  await user.click(screen.getByRole("button", { name: "Copy code" }));
  expect(copy).toHaveBeenCalledWith("bun test");
  await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
});

test("the corner rule knows the new primitives' own shapes", () => {
  expect(primitiveShapes["Collapsible.Trigger"]).toEqual([8, null]);
  expect(triggerVariants().root()).toContain("rounded-sm");
  expect(primitiveShapes.CodeBlock).toEqual([12, 4]);
  mount(() => <CodeBlock code="x" />);
  const figure = document.querySelector('[data-slot="code-block"]')!;
  expect(figure.className).toContain("rounded-md");
  expect(figure.className).toContain("p-1");
});
