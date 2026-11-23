import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Capture the views served by the real database, including tool/helper order. */
export function turnParity(h, suite) {
  const directory = process.env.TOKAMAK_TURN_PARITY_DIR;
  const samples = {};
  return {
    async capture(name, turn, extra = {}) {
      if (!directory) return;
      function report({ _id, _creationTime, turnId, startedAt, finishedAt, ...content }) {
        assert.ok(Number.isFinite(startedAt));
        assert.ok(finishedAt >= startedAt, `${name}: finished step has valid timestamps`);
        return content;
      }
      const steps = (await turn.steps()).map(report);
      for (const helper of turn.reply.helpers) {
        steps.push({ ...report(helper), text: await turn.helper(helper) });
      }
      samples[name] = {
        text: turn.text,
        thinking: await turn.thinking(),
        tasks: turn.reply.tasks,
        plan: turn.reply.plan,
        usage: turn.reply.usage,
        steers: turn.reply.steers,
        steps: steps.sort((a, b) => a.n - b.n),
        session: turn.row.sessionId,
        state: turn.row.state,
        error: turn.row.error,
        ...extra,
      };
    },
    async verify() {
      if (!directory) return;
      const file = join(directory, `${suite}.json`);
      const json = JSON.stringify(samples, null, 2).replaceAll(h.scratch, "<scratch>");
      if (process.env.TOKAMAK_PLUGIN_RUNTIME === "quickjs") {
        const expected = JSON.parse(await readFile(file, "utf8"));
        const actual = JSON.parse(json);
        assert.deepEqual(Object.keys(actual), Object.keys(expected));
        for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], key);
      } else {
        await writeFile(file, json);
      }
      console.log(`${suite} turn snapshots: ${Object.keys(samples).join(", ")}`);
    },
  };
}
