import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_CACHE_DIR,
  RUNS_DIR,
  assertSafeId,
  parseArgs,
  renderReport,
  summarize,
} from "./lib.mjs";
import { loadVerifiedCases } from "./protocol.mjs";

const args = parseArgs(process.argv.slice(2));
const runId = assertSafeId(args.run, "run id");
const cacheDir = resolve(args.cache ?? DEFAULT_CACHE_DIR);
const verified = await loadVerifiedCases(runId, cacheDir);
const summary = summarize(verified.cases, verified.selection.tasks);
summary.runId = runId;
summary.datasetRevision = verified.selection.datasetRevision;
summary.assetCount = verified.selection.assetCount;
summary.assetBytes = verified.selection.assetBytes;
summary.generatedAt = new Date().toISOString();

const runDir = resolve(RUNS_DIR, runId);
await mkdir(runDir, { recursive: true });
await writeFile(resolve(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(resolve(runDir, "report.md"), renderReport(summary));

const pct = (value) => `${(value * 100).toFixed(1)}%`;
console.log(`WebForge ${summary.track}: ${summary.correct}/${summary.total} (${pct(summary.accuracy)})`);
console.log(`Report: ${resolve(runDir, "report.md")}`);
