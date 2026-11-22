import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, For } from "solid-js";
import type { SignInFormFields } from "../host/sign-in";
import { Field } from "./field";

export function ProviderFields(props: {
  form: SignInFormFields;
  password: "current" | "new" | "temporary";
  autofocus: boolean;
}): JSX.Element {
  const order = { text: 0, email: 1, password: 2 };
  return (
    <For each={Object.entries(props.form).sort((a, b) => order[a[1]] - order[b[1]])}>
      {([name, type], index) => (
        <CredentialField
          name={name}
          label={
            name === "password" && props.password === "temporary" ? "Temporary password" : fieldLabel(name)
          }
          type={type}
          autofocus={index() === 0 && props.autofocus}
          autocomplete={
            type === "password"
              ? props.password === "current"
                ? "current-password"
                : "new-password"
              : type === "email"
                ? "email"
                : "username"
          }
        />
      )}
    </For>
  );
}

export function CredentialField(props: {
  name: string;
  label: string;
  type?: "text" | "email" | "password";
  autocomplete?: string;
  autofocus?: boolean;
}): JSX.Element {
  const [value, setValue] = createSignal("", { ownedWrite: true });
  const id = createUniqueId();
  return <Field {...props} id={id} value={value()} onInput={setValue} required visibleLabel />;
}

function fieldLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function passwordError(kind: string): string | undefined {
  switch (kind) {
    case "InvalidUsername":
      return "Use letters, numbers, dots, underscores, or hyphens in the username.";
    case "InvalidEmail":
      return "Enter a valid email address.";
    case "InvalidPassword":
      return "Choose a password with 8–256 characters.";
    case "PasswordUnchanged":
      return "Choose a password different from the current one.";
    case "LoginTaken":
      return "That username or email is already in use.";
  }
}
