import type { TokamakClient } from "../../sdk/src/index";
import { api } from "./fixtures/query-hooks/team/src/server/_generated/api";

// Each sample includes SDK transport, coordinator, JS, the database read or
// transaction commit, and the transport reply. Builds and warmup are excluded.
export async function measureHooks(client: TokamakClient) {
  const cases = {
    queryPlain: () => client.query(api.bench.readPlain, {}),
    queryNoop: () => client.query(api.bench.readNoop, {}),
    queryTable: () => client.query(api.bench.readTable, {}),
    mutationPlain: () => client.mutation(api.bench.savePlain, { name: "benchmark" }),
    mutationNoop: () => client.mutation(api.bench.saveNoop, { name: "benchmark" }),
    mutationTable: () => client.mutation(api.bench.saveTable, { name: "benchmark" }),
  };
  const samples = 101;
  const medians = Object.fromEntries(Object.keys(cases).map((name) => [name, [] as number[]]));
  for (let iteration = -20; iteration < samples; iteration++) {
    for (const [name, call] of Object.entries(cases)) {
      const start = performance.now();
      await call();
      if (iteration >= 0) medians[name].push(performance.now() - start);
    }
  }
  console.error(
    "Median milliseconds:",
    JSON.stringify(
      Object.fromEntries(
        Object.entries(medians).map(([name, times]) => [name, times.sort((a, b) => a - b)[samples >> 1]]),
      ),
    ),
  );
}
