import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BENCHMARK_DIR,
  TRACK_ID,
  assertSafeId,
  currentCleanProtocolRevision,
  expectedHash,
  parseArgs,
  renderReport,
  resolveCommittedRevision,
  sha256,
  summarize,
} from "./lib.mjs";
import { loadVerifiedCases } from "./protocol.mjs";

function requiredMetadata(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`--${key} is required and must fit on one line`);
  }
  return value.trim();
}

const args = parseArgs(process.argv.slice(2));
const runId = assertSafeId(args.run, "run id");
const runnerInstances = Number(args.runners);
if (!Number.isInteger(runnerInstances) || runnerInstances < 1) {
  throw new Error("--runners must be a positive integer");
}

const verified = await loadVerifiedCases(runId);
const cases = verified.cases;
const summary = summarize(cases, verified.selection.tasks);
summary.runId = runId;
summary.datasetRevision = verified.selection.datasetRevision;
summary.assetCount = verified.selection.assetCount;
summary.assetBytes = verified.selection.assetBytes;
if (summary.track !== TRACK_ID || summary.attempted !== summary.total || summary.total !== 21) {
  throw new Error("Only a complete 21-task result for the current frozen track can be published");
}
if (summary.evidenceCoverage !== 1) throw new Error("A published result requires evidence for every task");

const publisherRevision = currentCleanProtocolRevision();
const version3Cases = cases.filter((entry) => entry.version === 3);
let executionProtocolRevision;
let originIsolation;
if (version3Cases.length === cases.length) {
  const revisions = [...new Set(cases.map((entry) => entry.executionProtocolRevision))];
  if (revisions.length !== 1) throw new Error("Run mixes execution protocol revisions");
  executionProtocolRevision = resolveCommittedRevision(revisions[0], "execution-revision");
  originIsolation = `${cases.length} recorded task-specific <task-id>.localhost origins`;
} else if (version3Cases.length > 0) {
  throw new Error("A published run cannot mix historical and current case formats");
} else {
  executionProtocolRevision = resolveCommittedRevision(
    requiredMetadata(args, "execution-revision"),
    "execution-revision",
  );
  originIsolation = requiredMetadata(args, "origin-isolation");
}

const runtime = {
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  agentRuntime: requiredMetadata(args, "agent"),
  model: requiredMetadata(args, "model"),
  reasoningEffort: requiredMetadata(args, "reasoning"),
  runnerInstances,
  executionSplit: requiredMetadata(args, "split"),
  browserExecutor: requiredMetadata(args, "executor"),
  browserSurfaces: [...new Set(cases.map((entry) => entry.browser))].sort(),
  originIsolation,
};

const answerHashesContents = Buffer.from(`${JSON.stringify(verified.answers, null, 2)}\n`);
if (sha256(answerHashesContents) !== verified.frozen.answerHashesSha256) {
  throw new Error("Re-serialized expected answer hashes do not match the frozen track commitment");
}
const caseById = new Map(cases.map((entry) => [entry.taskId, entry]));
const auditableCases = summary.cases.map((row) => ({
  ...row,
  submittedAnswerSha256: expectedHash(caseById.get(row.taskId).answer),
}));

const resultsRoot = resolve(BENCHMARK_DIR, "results");
const resultDir = resolve(resultsRoot, runId);
const temporary = resolve(resultsRoot, `.${runId}.${process.pid}.tmp`);
await mkdir(resultsRoot, { recursive: true });
await mkdir(temporary);
await mkdir(resolve(temporary, "evidence"));

try {
  const evidence = [];
  for (const row of auditableCases) {
    const item = verified.evidenceByTask.get(row.taskId);
    if (!item) throw new Error(`Missing verified evidence for ${row.taskId}`);
    const destinationName = `${row.taskId}${item.media.extension}`;
    await writeFile(resolve(temporary, "evidence", destinationName), item.contents, { flag: "wx" });
    evidence.push({
      taskId: row.taskId,
      file: `evidence/${destinationName}`,
      mimeType: item.media.mimeType,
      sha256: sha256(item.contents),
      bytes: item.contents.length,
    });
  }

  await writeFile(resolve(temporary, "expected-answer-hashes.json"), answerHashesContents, { flag: "wx" });
  const generatedAt = new Date().toISOString();
  const published = {
    ...summary,
    cases: auditableCases,
    generatedAt,
    executionProtocolRevision,
    publisherRevision,
    runtime,
    trackDisclosure: {
      status: "retired-disclosed",
      reason: "Published final-state evidence and expected-answer hashes can reveal benchmark answers.",
      futureBlindEvaluation: "Freeze a new held-out track and exclude this results directory from every runner context.",
    },
    scoringAudit: {
      normalization: "Unicode NFKC followed by removal of outer whitespace only",
      comparison: "SHA-256(normalized submitted answer) equals the pinned expected hash for the task",
      submittedHashField: "cases[].submittedAnswerSha256",
      expectedHashesFile: "expected-answer-hashes.json",
      expectedHashesFileSha256: verified.frozen.answerHashesSha256,
    },
    metricDefinitions: {
      actions: "runner-reported navigation, click, fill, select, press, and scroll interactions",
      elapsedSeconds: "runner-reported wall time from opening the task through visible final state",
      evidenceCoverage: "presence of one non-empty final-state screenshot file per attempted task; not independent visual adjudication",
      ci95: "Wilson score interval under a 21-case binomial model; not an inference to the deterministic 934-task upstream suite",
    },
    evidence,
  };
  await writeFile(resolve(temporary, "summary.json"), `${JSON.stringify(published, null, 2)}\n`, { flag: "wx" });

  const analysisPath = resolve(BENCHMARK_DIR, "analyses", `${runId}.md`);
  let analysisLine = "";
  try {
    await access(analysisPath);
    analysisLine = `Human-reviewed failure analysis: [${runId}](../../analyses/${runId}.md)`;
  } catch {
    // Human analysis is optional; protocol disclosures below are always generated.
  }

  const reportTail = [
    "",
    "## Claim boundary and disclosure",
    "",
    "This is exact completion on a selected 21-case operation-code track, not an official score on the full 934-task WebForge suite. The upstream suite mixes three answer types and uses semantic LLM judging, so percentage-point deltas, ranks, outperformance, and state-of-the-art claims are invalid.",
    "",
    "This track is **retired/disclosed**. Unredacted final-state screenshots and the expected-answer hash commitment are published for auditability and can expose or facilitate recovery of answers. Any future blind run must freeze a new held-out track and exclude this result directory from runner context.",
    ...(analysisLine ? ["", analysisLine] : []),
    "",
    "## Independent scoring audit",
    "",
    `Expected hashes: [download](expected-answer-hashes.json) (SHA-256 \`${verified.frozen.answerHashesSha256}\`). Each case in \`summary.json\` publishes the submitted-answer SHA-256. Equality with that task's expected hash independently reproduces its correctness and the ${summary.correct}/${summary.total} total without revealing the raw submitted-answer field.`,
    "",
    "## Recorded runtime",
    "",
    `- Agent runtime: ${runtime.agentRuntime}`,
    `- Model: ${runtime.model}`,
    `- Reasoning setting: ${runtime.reasoningEffort}`,
    `- Runner instances: ${runtime.runnerInstances}`,
    `- Execution split: ${runtime.executionSplit}`,
    `- Browser executor: ${runtime.browserExecutor}`,
    `- Browser surfaces: ${runtime.browserSurfaces.join(", ")}`,
    `- Origin isolation: ${runtime.originIsolation}`,
    `- Host: Node ${runtime.node}, ${runtime.platform}/${runtime.architecture}`,
    "",
    "## Final-state evidence",
    "",
    "| Task | Screenshot | SHA-256 |",
    "| --- | --- | --- |",
    ...evidence.map((entry) => `| \`${entry.taskId}\` | [view](${entry.file}) | \`${entry.sha256}\` |`),
    "",
    `Execution protocol revision: \`${executionProtocolRevision}\``,
    "",
    `Publisher revision: \`${publisherRevision}\` (benchmark protocol files verified clean before publication)`,
    "",
  ].join("\n");
  await writeFile(
    resolve(temporary, "report.md"),
    `${renderReport(summary).trimEnd()}\n${reportTail}`,
    { flag: "wx" },
  );
  await rename(temporary, resultDir);
  console.log(`Published independently auditable benchmark result: ${resultDir}`);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
