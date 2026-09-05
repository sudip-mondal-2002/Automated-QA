#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateResult, json, readJson, renderReport } from "./result.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

function options(argv) {
  const parsed = { cacheDirectory: path.resolve(ROOT, ".benchmark-cache/qa") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run") parsed.runId = argv[++index];
    else if (argv[index] === "--cache-dir") parsed.cacheDirectory = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(parsed.runId ?? "")) throw new Error("--run requires a safe run id");
  parsed.runDirectory = path.resolve(HERE, "results", parsed.runId);
  return parsed;
}

const parsed = options(process.argv.slice(2));
const result = await calculateResult(parsed);
const metadata = await readJson(path.resolve(parsed.runDirectory, "run.json"));
await mkdir(parsed.runDirectory, { recursive: true });
await writeFile(path.resolve(parsed.runDirectory, "summary.json"), json(result));
await writeFile(path.resolve(parsed.runDirectory, "report.md"), renderReport(result, metadata));
console.log(`Auto-QA Core ${result.runId}: ${(result.composite.score * 100).toFixed(1)}% composite`);
console.log(`Generation F1 ${(result.generation.f1 * 100).toFixed(1)}%; regression ${result.regression.correct}/${result.regression.total}; healing ${result.healing.safeHeals}/${result.healing.total}`);
console.log(`Report: ${path.resolve(parsed.runDirectory, "report.md")}`);
