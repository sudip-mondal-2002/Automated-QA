import assert from "node:assert/strict";
import test from "node:test";
import { createTracer, traceEvent } from "../src/trace.js";

const fixedNow = () => new Date("2026-09-04T10:00:00.000Z");

test("traceEvent builds a stable JSON line with defaults", () => {
  const entry = traceEvent({ seq: 1, stage: "plan", event: "stage_started", now: fixedNow });
  assert.deepEqual(entry, {
    seq: 1,
    ts: "2026-09-04T10:00:00.000Z",
    stage: "plan",
    event: "stage_started",
    level: "info",
    message: "",
  });
});

test("traceEvent preserves level, message, data and non-Date clocks", () => {
  const entry = traceEvent({
    seq: 2,
    stage: "gate",
    event: "decision",
    level: "warn",
    message: "replan",
    data: { score: 0.62 },
    now: () => "2026-09-04T10:01:00.000Z",
  });
  assert.equal(entry.level, "warn");
  assert.equal(entry.message, "replan");
  assert.deepEqual(entry.data, { score: 0.62 });
  assert.equal(entry.ts, "2026-09-04T10:01:00.000Z");
});

test("tracer emits ordered entries and redacts secrets", async () => {
  const lines = [];
  const tracer = createTracer({
    now: fixedNow,
    writeLine: async (line) => lines.push(line),
    sensitiveValues: ["super-secret"],
  });
  const first = await tracer.emit("probe", "stage_started", { message: "GET super-secret" });
  const second = await tracer.emit("plan", "gap_found", { level: "warn", message: "missing", data: { area: "/checkout" } });

  assert.equal(tracer.seq, 2);
  assert.equal(tracer.degraded, false);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"seq":1/);
  assert.doesNotMatch(lines[0], /super-secret/);
  assert.match(lines[0], /\[REDACTED\]/);
  assert.equal(first.seq, 1);
  assert.equal(second.level, "warn");
  const closed = await tracer.close();
  assert.equal(closed.degraded, false);
  assert.equal(closed.buffered.length, 0);
});

test("tracer buffers in-memory without a writer and on write failure", async () => {
  const memory = createTracer({ now: fixedNow });
  await memory.emit("plan", "stage_started");
  assert.equal(memory.buffered.length, 1);
  assert.equal(memory.seq, 1);

  const failing = createTracer({
    now: fixedNow,
    writeLine: async () => {
      throw new Error("disk full");
    },
  });
  await failing.emit("gate", "decision", { message: "escalate" });
  assert.equal(failing.degraded, true);
  assert.equal(failing.buffered.length, 1);
  const closed = await failing.close();
  assert.equal(closed.degraded, true);
  assert.match(closed.buffered[0], /escalate/);
});
