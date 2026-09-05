import { mkdir, open } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  DEFAULT_CACHE_DIR,
  ROOT,
  RUNS_DIR,
  assertSafeId,
  currentCleanProtocolRevision,
  expectedHash,
  parseArgs,
  validateTaskOrigin,
} from "./lib.mjs";
import { loadVerifiedCache, readEvidence } from "./protocol.mjs";

const args = parseArgs(process.argv.slice(2));
const runId = assertSafeId(args.run, "run id");
const taskId = assertSafeId(args.task, "task id");
const actions = Number(args.actions);
const elapsedSeconds = Number(args.elapsed);
if (!Number.isInteger(actions) || actions < 0 || actions > 50) throw new Error("--actions must be an integer from 0 through 50");
if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error("--elapsed must be a non-negative number");
const cacheDir = resolve(args.cache ?? DEFAULT_CACHE_DIR);
const { selection, answers } = await loadVerifiedCache(cacheDir);
const task = selection.tasks.find((entry) => entry.id === taskId);
if (!task) throw new Error(`Task ${taskId} is outside the pinned track`);
const answer = args.answer ?? "";
if (!answer.trim()) throw new Error("--answer must contain the final operation code");
if (typeof answers[taskId] !== "string") throw new Error(`Pinned answer hash is missing for ${taskId}`);
const origin = validateTaskOrigin(args.origin, taskId);
const executionProtocolRevision = currentCleanProtocolRevision();

if (!args.evidence) throw new Error("--evidence is required");
const evidenceDir = resolve(RUNS_DIR, runId, "evidence");
const evidencePath = resolve(args.evidence);
const evidence = await readEvidence(evidencePath, evidenceDir, taskId).catch((error) => {
  if (error.code === "ENOENT") throw new Error(`Evidence file does not exist: ${evidencePath}`);
  throw error;
});

const result = {
  version: 3,
  taskId,
  track: selection.track,
  domain: task.domain,
  domainName: task.domain_name,
  level: task.level,
  answer,
  correct: expectedHash(answer) === answers[taskId],
  actions,
  elapsedSeconds,
  attempts: 1,
  browser: args.browser ?? "Codex in-app Browser",
  origin,
  executionProtocolRevision,
  evidence: relative(ROOT, evidence.path),
  evidenceMimeType: evidence.media.mimeType,
  recordedAt: new Date().toISOString(),
};
const casesDir = resolve(RUNS_DIR, runId, "cases");
await mkdir(casesDir, { recursive: true });
const resultPath = resolve(casesDir, `${taskId}.json`);
let handle;
try {
  handle = await open(resultPath, "wx", 0o600);
} catch (error) {
  if (error.code === "EEXIST") throw new Error(`Result already exists for ${taskId}; one attempt is allowed`);
  throw error;
}
try {
  await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await handle.close();
}
console.log(`${taskId}: ${result.correct ? "correct" : "incorrect"}`);
