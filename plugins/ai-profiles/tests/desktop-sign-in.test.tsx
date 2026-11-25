import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SignIn, Subscription } from "../src/client/lib/api";
import * as desktop from "../src/client/lib/desktop";
import { AddDialog, type Step } from "../src/client/ui/add-dialog";

vi.mock("../src/client/lib/desktop", () => ({
  hasDesktopSignIn: vi.fn(),
  listenForSignInReturn: vi.fn(),
  cancelSignInReturn: vi.fn(),
  openSignInBrowser: vi.fn(),
}));

const address = "http://localhost:54545/callback?code=synthetic&state=test";
const subscription: Subscription = {
  id: "subscription",
  company: "anthropic",
  method: "subscription",
  label: "Personal",
  enabled: true,
  plan: "Pro",
  status: "ok",
  accounts: [],
  models: [],
  createdAt: 1,
};

function pendingReturn() {
  type Result = Awaited<ReturnType<typeof desktop.listenForSignInReturn>>;
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount() {
  const signIn: SignIn = {
    id: "sign-in",
    company: "anthropic",
    method: "subscription",
    link: "https://claude.example/authorize",
    startedAt: Date.now(),
    expired: false,
  };
  const [step, setStep] = createSignal<Step | undefined>({ kind: "sign-in", signIn });
  const finish = vi.fn(
    async (
      _signIn: SignIn,
      _address: string,
    ): Promise<
      | Subscription
      | {
          failed: true;
          kind: string;
          data: { message: string };
        }
    > => subscription,
  );
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <AddDialog
        step={step()}
        onStep={setStep}
        start={async () => signIn}
        finish={finish}
        setLabel={async () => null}
      />
    ),
    root,
  );
  unmount = () => {
    dispose();
    root.remove();
    unmount = undefined;
  };
  return { finish, signIn, setStep, dialog: screen.findByRole("dialog") };
}

let unmount: (() => void) | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(desktop.hasDesktopSignIn).mockReturnValue(true);
  vi.mocked(desktop.cancelSignInReturn).mockResolvedValue(undefined);
  vi.mocked(desktop.openSignInBrowser).mockResolvedValue("opened");
});

afterEach(async () => {
  for (const close of document.querySelectorAll<HTMLElement>('[role="dialog"] [aria-label="Close"]'))
    close.click();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  unmount?.();
  document.body.replaceChildren();
});

test("desktop opens the system browser and finishes its return through the paste handler", async () => {
  const pending = pendingReturn();
  vi.mocked(desktop.listenForSignInReturn).mockReturnValue(pending.promise);
  const { signIn, finish, dialog } = mount();

  fireEvent.click(within(await dialog).getByRole("button", { name: "Open sign-in page" }));
  expect(desktop.openSignInBrowser).toHaveBeenCalledWith(signIn.link);
  expect(desktop.listenForSignInReturn).toHaveBeenCalledWith(
    expect.objectContaining({ port: 54545, path: "/callback" }),
  );
  pending.resolve({ status: "returned", address });
  expect(await screen.findByText("Connected")).toBeTruthy();
  expect(finish).toHaveBeenCalledExactlyOnceWith(signIn, address);
});

test("a wrong state leaves sign-in waiting and rearms the one-shot listener", async () => {
  vi.mocked(desktop.listenForSignInReturn)
    .mockResolvedValueOnce({ status: "returned", address })
    .mockReturnValue(new Promise(() => {}));
  const { finish } = mount();
  finish.mockResolvedValueOnce({ failed: true, kind: "WrongSignIn", data: { message: "Wrong state" } });
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong state");
  expect(desktop.listenForSignInReturn).toHaveBeenCalledTimes(2);
});

test.each(["busy", "unavailable"] as const)("%s desktop listener leaves paste available", async (status) => {
  vi.mocked(desktop.hasDesktopSignIn).mockReturnValue(status !== "unavailable");
  vi.mocked(desktop.listenForSignInReturn).mockResolvedValue({ status });
  const { signIn, finish, dialog } = mount();
  const user = userEvent.setup({ document });
  const open = within(await dialog);
  const field = open.getByRole("textbox", { name: /Address the sign-in/ });
  await user.clear(field);
  await user.type(field, address);
  await user.click(open.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("Connected")).toBeTruthy();
  expect(finish).toHaveBeenCalledExactlyOnceWith(signIn, address);
});

test.each(["cancel", "expiry", "close", "unmount"] as const)(
  "%s stops the listener and ignores a late return",
  async (end) => {
    const pending = pendingReturn();
    vi.mocked(desktop.listenForSignInReturn).mockReturnValue(pending.promise);
    const { finish, dialog, signIn, setStep } = mount();
    const open = await dialog;
    const [[{ requestId }]] = vi.mocked(desktop.listenForSignInReturn).mock.calls;
    if (end === "unmount") unmount?.();
    else if (end === "close") fireEvent.click(within(open).getByRole("button", { name: "Close" }));
    // These are the same transitions the Profiles view applies on server updates.
    else if (end === "expiry") setStep({ kind: "sign-in", signIn: { ...signIn, expired: true } });
    else setStep(undefined);
    await waitFor(() => expect(desktop.cancelSignInReturn).toHaveBeenCalledExactlyOnceWith(54545, requestId));
    pending.resolve({ status: "returned", address });
    await pending.promise;
    expect(finish).not.toHaveBeenCalled();
  },
);
