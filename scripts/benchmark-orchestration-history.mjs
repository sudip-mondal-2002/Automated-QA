#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const weight = position - lower;
  return Math.round((sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * weight) * 100) / 100;
}

function summary(values) {
  const medianMs = percentile(values, 0.5);
  const madMs = percentile(values.map((value) => Math.abs(value - medianMs)), 0.5);
  return { samples: values.length, medianMs, p95Ms: percentile(values, 0.95), madMs, minMs: Math.min(...values), maxMs: Math.max(...values) };
}

const args = process.argv.slice(2);
const samples = Number(option(args, "--samples", "10"));
const warmups = Number(option(args, "--warmups", "3"));
const moduleRoot = path.resolve(option(args, "--module-root", path.resolve(import.meta.dirname, "..")));
const outputPath = option(args, "--output");
if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(warmups) || warmups < 0 || args.length > 0) throw new Error("Usage: benchmark-orchestration-history.mjs [--samples N] [--warmups N] [--module-root PATH] [--output FILE]");
const require = createRequire(path.join(moduleRoot, "package.json"));
const { chromium } = require("@playwright/test");

const runtime = await import(`${pathToFileURL(path.join(moduleRoot, "src", "index.js")).href}?benchmark=${Date.now()}`);
const { createPlaywrightDriver } = await import(`${pathToFileURL(path.join(moduleRoot, "src", "playwright-executor.js")).href}?benchmark=${Date.now()}`);
const supportsHistory = typeof runtime.createHistoryRequest === "function";

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/ready") {
    response.end("<!doctype html><title>Status ready</title><main><h1>Ready page</h1><p>Status panel is ready.</p></main>");
    return;
  }
  response.end("<!doctype html><title>Status</title><main><h1>Status panel</h1><a href='/ready'>Open status</a></main>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const nativeBrowser = await chromium.launch({ headless: true });

const prompt = "verify that opening the status panel shows the ready page";
const draft = {
  flows: [{
    id: "status-panel-ready",
    title: "Open the status panel",
    category: "happy",
    priority: "high",
    rationale: "Directly exercises the requested route transition.",
    pages: ["/", "/ready"],
    steps: [{
      intent: "Open status",
      page: "/",
      action: "click",
      expect: [{ prose: "Ready page", assert: { kind: "url_contains", value: "/ready" } }],
    }],
  }],
};

let replayLaunches = 0;
const browserLauncher = async () => {
  replayLaunches += 1;
  return chromium.launch({ headless: true });
};

async function traceSummary(directory) {
  const lines = (await readFile(path.join(directory, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  return {
    events: lines.length,
    historyEvents: lines.filter((entry) => /history|memory|reuse/.test(`${entry.stage}:${entry.event}`)).map((entry) => entry.event),
    stages: Object.fromEntries(lines.filter((entry) => entry.data?.durationMs !== undefined).map((entry) => [`${entry.stage}:${entry.event}`, entry.data.durationMs])),
  };
}

async function runOne(root, historyMode) {
  let plannerCalls = 0;
  let executorFactoryCalls = 0;
  let eagerContext;
  let eagerExecutor;
  const executorFactory = async () => {
    executorFactoryCalls += 1;
    const context = await nativeBrowser.newContext();
    const page = await context.newPage();
    const executor = createPlaywrightDriver({ page, baseUrl });
    executor.driver.close = async () => context.close();
    return executor;
  };
  const started = performance.now();
  if (!supportsHistory) {
    executorFactoryCalls += 1;
    eagerContext = await nativeBrowser.newContext();
    eagerExecutor = createPlaywrightDriver({ page: await eagerContext.newPage(), baseUrl });
  }
  const beforeLaunches = replayLaunches;
  const result = await runtime.orchestrate({
    url: baseUrl,
    root,
    prompt,
    planner: async () => { plannerCalls += 1; return structuredClone(draft); },
    planningConcurrency: 1,
    plannerAttempts: 1,
    maxPages: 5,
    maxDepth: 2,
    appRevision: "immutable-status-app-v1",
    historyMode,
    executor: eagerExecutor,
    executorFactory: supportsHistory ? executorFactory : undefined,
    executionConcurrency: 3,
    browserLauncher,
  });
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  await eagerContext?.close();
  if (!result.report) throw result.error ?? new Error("orchestration produced no report");
  const scenario = result.report.scenarios[0];
  const workspace = new runtime.QaWorkspace(root);
  const saved = scenario?.runId ? await workspace.loadResult(scenario.runId) : null;
  return {
    durationMs,
    orchestrationId: result.report.orchestrationId,
    verdict: result.report.summary.verdict,
    exitCode: result.exitCode,
    history: result.history?.kind ?? "unsupported",
    plannerCalls,
    executorFactoryCalls,
    replayLaunches: replayLaunches - beforeLaunches,
    executionMode: saved?.execution?.mode,
    agentCalls: saved?.execution?.agentCalls,
    replayState: saved?.execution?.script?.state,
    replayAttempts: (saved?.execution?.attempts ?? []).filter((attempt) => attempt.engine === "playwright").map(({ status, reason, durationMs, validation }) => ({ status, ...(reason ? { reason } : {}), durationMs, validation: Boolean(validation) })),
    sourceHash: saved?.execution?.script?.sourceHash,
    scriptHash: saved?.execution?.script?.scriptHash,
    screenshots: saved?.evidence?.screenshots?.length ?? 0,
    trace: await traceSummary(result.artifacts.dir),
  };
}

const pairs = [];
try {
  for (let index = 0; index < samples + warmups; index += 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), `auto-qa-history-benchmark-${index}-`));
    try {
      const cold = await runOne(root, "off");
      const repeat = await runOne(root, "lookup");
      if (index >= warmups) pairs.push({ index: index - warmups + 1, cold, repeat, speedupPct: Math.round(((cold.durationMs - repeat.durationMs) / cold.durationMs) * 10_000) / 100 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
} finally {
  await nativeBrowser.close();
  await new Promise((resolve) => server.close(resolve));
}

const cold = pairs.map((pair) => pair.cold.durationMs);
const repeat = pairs.map((pair) => pair.repeat.durationMs);
const aggregate = {
  benchmarkVersion: 1,
  measuredAt: new Date().toISOString(),
  moduleRoot,
  supportsHistory,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  prompt,
  samples,
  warmups,
  cold: summary(cold),
  repeat: summary(repeat),
  medianSpeedupPct: Math.round(((percentile(cold, 0.5) - percentile(repeat, 0.5)) / percentile(cold, 0.5)) * 10_000) / 100,
  correctnessParity: pairs.every((pair) => pair.cold.verdict === "clean"
    && pair.cold.verdict === pair.repeat.verdict
    && pair.cold.exitCode === 0
    && pair.cold.exitCode === pair.repeat.exitCode
    && pair.cold.sourceHash === pair.repeat.sourceHash
    && pair.cold.scriptHash === pair.repeat.scriptHash),
  historyHitRate: pairs.filter((pair) => pair.repeat.history === "exact").length / pairs.length,
  directReplayHitRate: pairs.filter((pair) => pair.repeat.executionMode === "playwright" && pair.repeat.agentCalls === 0 && pair.repeat.replayState === "trusted").length / pairs.length,
  pairs,
};
const serialized = `${JSON.stringify(aggregate, null, 2)}\n`;
if (outputPath) await writeFile(path.resolve(outputPath), serialized);
process.stdout.write(serialized);
