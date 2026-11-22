import { before } from "@tokamak/sdk/client";
import { Composer } from "plugin:owner/client";

export const Badge = before(Composer.sendButton, ({ label }) => <small>Built for {label}</small>);
