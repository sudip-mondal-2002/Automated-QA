import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_DIR,
  TRACK_ID,
  assertSafeId,
  parseArgs,
  readJson,
  sha256,
  summarize,
} from "./lib.mjs";
import { readEvidence } from "./protocol.mjs";

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertHash(value, name) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error(`Invalid SHA-256 for ${name}`);
}

export async function verifyPublishedResult(runId, options = {}) {
  assertSafeId(runId, "run id");
  const benchmarkDir = resolve(options.benchmarkDir ?? BENCHMARK_DIR);
  const resultDir = resolve(options.resultDir ?? resolve(benchmarkDir, "results", runId));
  const frozen = await readJson(resolve(benchmarkDir, "track.json"));
  const summary = await readJson(resolve(resultDir, "summary.json"));
  if (frozen.track !== TRACK_ID || summary.track !== TRACK_ID) {
    throw new Error("Published result does not use the current checked-in track");
  }
  if (frozen.status !== "retired-disclosed"
    || summary.trackDisclosure?.status !== "retired-disclosed") {
    throw new Error("Published result must disclose that its answer-bearing track is retired");
  }

  const expectedFile = summary.scoringAudit?.expectedHashesFile;
  if (expectedFile !== "expected-answer-hashes.json") {
    throw new Error("Published result has an unexpected expected-hash artifact path");
  }
  const expectedContents = await readFile(resolve(resultDir, expectedFile));
  const expectedDigest = sha256(expectedContents);
  if (expectedDigest !== frozen.answerHashesSha256
    || expectedDigest !== summary.scoringAudit.expectedHashesFileSha256) {
    throw new Error("Published expected-answer hashes do not match the frozen commitment");
  }
  const expectedHashes = JSON.parse(expectedContents.toString("utf8"));
  if (!sameValues(Object.keys(expectedHashes), frozen.taskIds)) {
    throw new Error("Published expected-answer hash inventory does not match the frozen track");
  }

  const rows = summary.cases;
  if (!Array.isArray(rows)
    || !sameValues(rows.map((row) => row.taskId), frozen.taskIds)
    || new Set(rows.map((row) => row.taskId)).size !== frozen.taskIds.length) {
    throw new Error("Published case inventory does not match the frozen track");
  }
  const recomputedCases = [];
  for (const row of rows) {
    if ("answer" in row || "ground_truth" in row) {
      throw new Error(`Published result contains a raw answer field for ${row.taskId}`);
    }
    assertHash(row.submittedAnswerSha256, `submitted answer ${row.taskId}`);
    assertHash(expectedHashes[row.taskId], `expected answer ${row.taskId}`);
    const correct = row.submittedAnswerSha256 === expectedHashes[row.taskId];
    if (row.correct !== correct || row.attempted !== true || row.evidence !== true) {
      throw new Error(`Published correctness metadata mismatch for ${row.taskId}`);
    }
    recomputedCases.push({
      taskId: row.taskId,
      correct,
      actions: row.actions,
      elapsedSeconds: row.elapsedSeconds,
      evidence: true,
    });
  }

  const recomputed = summarize(
    recomputedCases,
    rows.map((row) => ({
      id: row.taskId,
      domain: row.domain,
      domain_name: row.domainName,
      level: row.level,
    })),
  );
  for (const key of [
    "track",
    "correct",
    "attempted",
    "total",
    "accuracy",
    "ci95",
    "meanActions",
    "meanElapsedSeconds",
    "evidenceCoverage",
    "byLevel",
    "byDomain",
  ]) {
    if (!sameValues(summary[key], recomputed[key])) {
      throw new Error(`Published aggregate mismatch: ${key}`);
    }
  }

  if (!Array.isArray(summary.evidence)
    || !sameValues(summary.evidence.map((entry) => entry.taskId), frozen.taskIds)) {
    throw new Error("Published evidence inventory does not match the frozen track");
  }
  for (const entry of summary.evidence) {
    const item = await readEvidence(
      resolve(resultDir, entry.file),
      resolve(resultDir, "evidence"),
      entry.taskId,
    );
    if (entry.file !== `evidence/${entry.taskId}${item.media.extension}`
      || entry.mimeType !== item.media.mimeType
      || entry.bytes !== item.contents.length
      || entry.sha256 !== sha256(item.contents)) {
      throw new Error(`Published evidence metadata mismatch for ${entry.taskId}`);
    }
  }

  if (!/^[a-f0-9]{40}$/.test(summary.executionProtocolRevision ?? "")
    || !/^[a-f0-9]{40}$/.test(summary.publisherRevision ?? "")) {
    throw new Error("Published Git revision metadata is incomplete");
  }
  return {
    runId,
    correct: recomputed.correct,
    total: recomputed.total,
    accuracy: recomputed.accuracy,
    evidence: summary.evidence.length,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyPublishedResult(assertSafeId(args.run, "run id"));
  console.log(
    `Verified ${result.runId}: ${result.correct}/${result.total}; ${result.evidence} evidence files`,
  );
}
