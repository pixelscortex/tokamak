import { expect, test } from "bun:test";
import { agentTurnHistory } from "../src/agent-turn.ts";
import { jsonBytes } from "../src/agent-reports.ts";
import { WORKER_DATA_BYTES } from "../src/worker-limits.ts";

const row = (text) => ({ role: "user", name: "Sam", text });
const note = (text) => ({ role: "note", name: "Tokamak", text });
const oneOmitted = note("1 earlier message of this thread is left out.");
const tenOmitted = note("10 earlier messages of this thread are left out.");
const newest = row("newest");
const oldest = row("older".repeat(100));

function start(history, budget) {
  const request = {
    threadId: "thread",
    turnId: "turn",
    folder: "/project",
    model: "sonnet",
    access: "full",
    prompt: "",
    history: [],
  };
  const empty = jsonBytes([{ ...request, version: 1 }]);
  return { ...request, prompt: "p".repeat(WORKER_DATA_BYTES - empty - budget), history };
}

test("recounts Chat's omission note when trimming more rows", () => {
  const nineOmitted = note("9 earlier messages of this thread are left out.");
  const budget = jsonBytes([tenOmitted, newest]) - 2;
  expect(agentTurnHistory(start([nineOmitted, oldest, newest], budget))).toEqual([tenOmitted, newest]);
});

test("reserves room for a new note before keeping history rows", () => {
  const budget = jsonBytes([oneOmitted, newest]) - 2;
  expect(agentTurnHistory(start([oldest, newest], budget))).toEqual([oneOmitted, newest]);
  expect(agentTurnHistory(start([oldest, newest], budget - 1))).toEqual([
    note("2 earlier messages of this thread are left out."),
  ]);
});

test("does not add a note when none of the history was dropped", () => {
  const rows = [oldest, newest];
  expect(agentTurnHistory(start(rows, jsonBytes(rows) - 2))).toEqual(rows);
  expect(agentTurnHistory(start([tenOmitted], jsonBytes([tenOmitted]) - 2))).toEqual([tenOmitted]);
});

test("rejects an oversized prompt even with no history", () => {
  expect(agentTurnHistory(start([], -1))).toBeUndefined();
  expect(agentTurnHistory(start([newest], 0))).toEqual([]);
});
