import { after, layer } from "@tokamak/sdk/client";
import { find } from "plugin:owner/client";

export const Badge = after(find("SendButton"), ({ label }) => <small>Built for {label}</small>);
export const Note = after(find("section", { in: "Composer" }), ({ label }) => <p>Notes for {label}</p>);

export const Profile = after(find("span", { in: "Labels", nth: 1 }), ({ labels, $row }) => (
  <small>
    Profile {$row.index() + 1}: {$row.item} of {labels.length}
  </small>
));

export const Body = layer(find("div", { in: "Composer", nth: 1 }), () => <div aria-label="replacement" />);

export const Nested = after(find("em"), ({ $row }) => (
  <small>
    Group {$row.parent.index() + 1}: {$row.parent.item} / {$row.index}: {$row.item()}
  </small>
));
