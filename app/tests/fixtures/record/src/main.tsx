import { itemRenderer, view, type Id } from "@tokamak/sdk";
import { useClient, useQuery } from "@tokamak/sdk/solid";
import { api } from "../backend/_generated/api";
export const Record = view({ route: "/" }, () => <p>Record fixture</p>);
export const RecordCard = itemRenderer({ type: "record.card" }, (props) => {
  const client = useClient();
  const id = () => (props.part.result as { id: Id<"records"> }).id;
  const row = useQuery(client, api.record.get, () => ({ id: id() }));
  return (
    <p data-record-card>
      <button
        role="checkbox"
        aria-checked={row.data()?.done ?? false}
        onClick={() => void client.mutation(api.record.toggle, { id: id() })}
      >
        {row.data()?.title ?? "Loading record…"}
      </button>
    </p>
  );
});
