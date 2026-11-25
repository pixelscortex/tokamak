import { after } from "@tokamak/sdk/client";
import { parts } from "plugin:owner/client";

export const Badge = after(parts.Composer.section.SendButton, ({ label }) => (
  <small>Built for {label}</small>
));
export const Note = after(parts.Composer.section, ({ label }) => <p>Notes for {label}</p>);
