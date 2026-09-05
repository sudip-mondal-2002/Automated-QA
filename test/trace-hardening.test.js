import assert from "node:assert/strict";
import test from "node:test";
import { createTracer, traceEvent } from "../src/trace.js";

test("trace defaults cover empty options and getters", () => {
  const empty = traceEvent();
  assert.equal(empty.level, "info");
  assert.equal(empty.message, "");

  const tracer = createTracer();
  assert.equal(tracer.seq, 0);
  assert.equal(tracer.degraded, false);
  assert.deepEqual(tracer.buffered, []);
});

test("tracer handles null payloads without crashing", async () => {
  const lines = [];
  const tracer = createTracer({ now: () => new Date("2026-09-04T10:00:00.000Z"), writeLine: async (l) => lines.push(l) });
  const entry = await tracer.emit("run", "step", null);
  assert.equal(entry.seq, 1);
  assert.equal(lines.length, 1);
  assert.equal(tracer.seq, 1);
  assert.equal(tracer.buffered.length, 0);
});
