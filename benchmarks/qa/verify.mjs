#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateResult, readJson } from "./result.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function verifyResult(runId, options = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(runId ?? "")) throw new Error("A safe run id is required");
  const runDirectory = path.resolve(options.runDirectory ?? path.resolve(HERE, "results", runId));
  const cacheDirectory = path.resolve(options.cacheDirectory ?? path.resolve(ROOT, ".benchmark-cache/qa"));
  const [published, recomputed] = await Promise.all([
    readJson(path.resolve(runDirectory, "summary.json")),
    calculateResult({ runDirectory, cacheDirectory }),
  ]);
  if (!valuesEqual(published, recomputed)) throw new Error(`Published QA result ${runId} does not reproduce exactly`);
  return {
    runId,
    composite: recomputed.composite.score,
    generationF1: recomputed.generation.f1,
    regressionCorrect: recomputed.regression.correct,
    regressionTotal: recomputed.regression.total,
    healingSafe: recomputed.healing.safeHeals,
    healingTotal: recomputed.healing.total,
    evidence: recomputed.evidence.length,
  };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const runIndex = process.argv.indexOf("--run");
  const runId = runIndex >= 0 ? process.argv[runIndex + 1] : "";
  const result = await verifyResult(runId);
  console.log(`Verified ${result.runId}: ${(result.composite * 100).toFixed(1)}% composite; ${result.evidence} evidence artifacts`);
}
