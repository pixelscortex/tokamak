import { state, view } from "@tokamak/sdk/client";

// Match the integration fixture's path and binding name to exercise the same compiler key.
const windowDraft = state("");

export const OtherDraftView = view({ route: "/" }, () => (
  <section aria-label="Other draft fixture">
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const draft = new FormData(event.currentTarget).get("draft");
        if (typeof draft === "string") windowDraft.set(draft);
      }}
    >
      <label>
        Draft <input name="draft" />
      </label>
      <button>Save drafts</button>
    </form>
    <p>Window draft: {windowDraft() || "empty"}</p>
  </section>
));
