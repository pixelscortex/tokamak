import { runnerLauncher } from "../../../packages/runtime/js/runner";
import { endpoint } from "./endpoint";

export const launchLocalWorker = runnerLauncher(endpoint);
