import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  BENCHMARK_DIR,
  DATASET_REVISION,
  DEFAULT_CACHE_DIR,
  ROOT,
  RUNS_DIR,
  SELECTION_SEED,
  TRACK_ID,
  assertSafeId,
  evidenceMedia,
  expectedHash,
  readJson,
  sha256,
  validateTaskOrigin,
} from "./lib.mjs";

function parseVerifiedJson(buffer, expectedDigest, name) {
  if (sha256(buffer) !== expectedDigest) throw new Error(`Pinned ${name} checksum mismatch`);
  return JSON.parse(buffer.toString("utf8"));
}

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function loadVerifiedCache(cacheDir = DEFAULT_CACHE_DIR) {
  const frozen = await readJson(resolve(BENCHMARK_DIR, "track.json"));
  if (frozen.track !== TRACK_ID
    || frozen.datasetRevision !== DATASET_REVISION
    || frozen.selectionSeed !== SELECTION_SEED) {
    throw new Error("Checked-in WebForge track metadata does not match the benchmark implementation");
  }

  const [selectionBuffer, assetLockBuffer, answersBuffer] = await Promise.all([
    readFile(resolve(cacheDir, "selection.json")),
    readFile(resolve(cacheDir, "assets.lock.json")),
    readFile(resolve(cacheDir, "answers.sha256.json")),
  ]);
  const selection = parseVerifiedJson(selectionBuffer, frozen.selectionSha256, "selection");
  const assetLock = parseVerifiedJson(assetLockBuffer, frozen.assetLockSha256, "asset lock");
  const answers = parseVerifiedJson(answersBuffer, frozen.answerHashesSha256, "answer hashes");

  const taskIds = selection.tasks?.map((task) => task.id) ?? [];
  const answerIds = Object.keys(answers);
  const assetBytes = assetLock.files?.reduce((sum, entry) => sum + entry.size, 0) ?? -1;
  if (selection.track !== TRACK_ID
    || selection.datasetRevision !== DATASET_REVISION
    || assetLock.datasetRevision !== DATASET_REVISION
    || !sameValues(taskIds, frozen.taskIds)
    || !sameValues(answerIds, frozen.taskIds)
    || selection.assetCount !== frozen.assetCount
    || selection.assetBytes !== frozen.assetBytes
    || assetLock.files?.length !== frozen.assetCount
    || assetBytes !== frozen.assetBytes) {
    throw new Error("Prepared WebForge cache does not match the checked-in frozen track");
  }

  return { frozen, selection, assetLock, answers };
}

export async function readEvidence(path, evidenceRoot, taskId) {
  const [rootPath, filePath] = await Promise.all([realpath(evidenceRoot), realpath(path)]);
  const inside = relative(rootPath, filePath);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`Invalid evidence path for ${taskId}`);
  }
  const evidenceStat = await stat(filePath);
  if (!evidenceStat.isFile() || evidenceStat.size === 0) throw new Error(`Invalid evidence for ${taskId}`);
  if (!basename(filePath).startsWith(`${taskId}.`)) throw new Error(`Evidence filename does not match ${taskId}`);
  const contents = await readFile(filePath);
  return { path: filePath, contents, media: evidenceMedia(contents) };
}

export async function loadVerifiedCases(runId, cacheDir = DEFAULT_CACHE_DIR) {
  assertSafeId(runId, "run id");
  const cache = await loadVerifiedCache(cacheDir);
  const runDir = resolve(RUNS_DIR, runId);
  const casesDir = resolve(runDir, "cases");
  let files = [];
  try {
    files = (await readdir(casesDir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const cases = await Promise.all(files.map((name) => readJson(resolve(casesDir, name))));
  const taskById = new Map(cache.selection.tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const origins = new Set();
  const evidenceByTask = new Map();

  for (let index = 0; index < cases.length; index += 1) {
    const result = cases[index];
    const filenameId = files[index].slice(0, -5);
    const task = taskById.get(result.taskId);
    if (!task || filenameId !== result.taskId) throw new Error(`Run contains out-of-track case file: ${files[index]}`);
    if (seen.has(result.taskId)) throw new Error(`Run contains duplicate task: ${result.taskId}`);
    if (![2, 3].includes(result.version)
      || result.track !== TRACK_ID
      || result.domain !== task.domain
      || result.domainName !== task.domain_name
      || result.level !== task.level
      || result.attempts !== 1
      || typeof result.answer !== "string"
      || !result.answer.trim()
      || !Number.isInteger(result.actions)
      || result.actions < 0
      || result.actions > 50
      || !Number.isFinite(result.elapsedSeconds)
      || result.elapsedSeconds < 0
      || typeof result.browser !== "string"
      || !result.browser.trim()
      || typeof result.evidence !== "string") {
      throw new Error(`Invalid protocol metadata for ${result.taskId}`);
    }
    if (result.version === 3) {
      let origin;
      try {
        origin = validateTaskOrigin(result.origin, result.taskId);
      } catch {
        throw new Error(`Invalid task-specific origin for ${result.taskId}`);
      }
      if (origin !== result.origin || origins.has(origin)) {
        throw new Error(`Run contains a missing or reused task origin: ${origin}`);
      }
      if (!/^[a-f0-9]{40}$/.test(result.executionProtocolRevision ?? "")) {
        throw new Error(`Invalid execution protocol revision for ${result.taskId}`);
      }
      origins.add(origin);
    }
    const correct = expectedHash(result.answer) === cache.answers[result.taskId];
    if (result.correct !== correct) throw new Error(`Stored correctness mismatch for ${result.taskId}`);
    seen.add(result.taskId);
    evidenceByTask.set(result.taskId, await readEvidence(
      resolve(ROOT, result.evidence),
      resolve(runDir, "evidence"),
      result.taskId,
    ));
  }

  return { ...cache, runDir, cases, evidenceByTask };
}
