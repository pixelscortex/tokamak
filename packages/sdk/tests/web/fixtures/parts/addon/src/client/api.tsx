import { after, replace } from "@tokamak/sdk/client";
import { parts } from "plugin:owner/client";

export const Badge = after(parts.Composer.section.SendButton, ({ label }) => (
  <small>Built for {label}</small>
));
export const Note = after(parts.Composer.section, ({ label }) => <p>Notes for {label}</p>);

export const Profile = after(parts.Labels.section.span, ({ labels, $row }) => (
  <small>
    Profile {$row.index() + 1}: {$row.item} of {labels.length}
  </small>
));

export const Body = replace(parts.Composer.section.div, () => <div aria-label="replacement" />);

export const Nested = after(parts.Labels.section.groups.em, ({ $row }) => (
  <small>
    Group {$row.parent.index() + 1}: {$row.parent.item} / {$row.index}: {$row.item()}
  </small>
));
