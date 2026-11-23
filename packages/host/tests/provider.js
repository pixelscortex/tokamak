import { basename } from "node:path";

export const contractProviders = {
  fixture: {
    contract: { place: "local", owner: "consumer", name: "fixture" },
    implementation: {
      id: "provider",
      run(input) {
        return input.callback.call(input, this.id, basename("/a/file"));
      },
    },
  },
};
