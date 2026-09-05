import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  DATASET_API_ROOT,
  DATASET_RESOLVE_ROOT,
  DATASET_REVISION,
  BENCHMARK_DIR,
  DEFAULT_CACHE_DIR,
  SELECTION_SEED,
  TASK_MANIFEST_SHA256,
  TASKS_URL,
  TRACK_ID,
  assetIntegrity,
  assertSafeId,
  expectedHash,
  findExternalUrls,
  isTextAsset,
  parseArgs,
  parseJsonLines,
  sanitizeTask,
  selectTrack,
  sha256,
  trackCandidates,
  verifyAsset,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const cacheDir = resolve(args.cache ?? DEFAULT_CACHE_DIR);
const websitesDir = resolve(cacheDir, "websites");
let downloaded = 0;

async function fetchValue(url, read, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return { response, value: await read(response) };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 500));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message ?? lastError}`, { cause: lastError });
}

async function fetchBuffer(url) {
  const { value } = await fetchValue(url, (response) => response.arrayBuffer());
  return Buffer.from(value);
}

async function fetchJson(url) {
  return fetchValue(url, (response) => response.json());
}

function nextPage(response, currentUrl) {
  const link = response.headers.get("link") ?? "";
  const match = link.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? new URL(match[1], currentUrl).href : null;
}

function fileUrl(path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${DATASET_RESOLVE_ROOT}/${DATASET_REVISION}/${encodedPath}?download=true`;
}

function assertDatasetPath(path, taskId) {
  const prefix = `websites/${taskId}/`;
  if (!path.startsWith(prefix)) throw new Error(`Unsafe dataset path: ${path}`);
  const destination = resolve(cacheDir, path);
  const inside = relative(websitesDir, destination);
  if (inside.startsWith("..") || resolve(websitesDir, inside) !== destination) {
    throw new Error(`Unsafe dataset path: ${path}`);
  }
  return destination;
}

async function fetchTaskTree(taskId) {
  assertSafeId(taskId, "task id");
  const path = `websites/${taskId}`;
  let url = `${DATASET_API_ROOT}/tree/${DATASET_REVISION}/${path}?recursive=true&limit=1000`;
  const entries = [];
  while (url) {
    const pageUrl = url;
    const { response, value } = await fetchJson(pageUrl);
    if (!Array.isArray(value)) throw new Error(`Unexpected dataset tree response for ${taskId}`);
    entries.push(...value);
    url = nextPage(response, pageUrl);
  }
  return entries
    .filter((entry) => entry.type === "file")
    .map((entry) => {
      assertDatasetPath(entry.path, taskId);
      assetIntegrity(entry);
      return entry;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function ensureAsset(entry, taskId) {
  const destination = assertDatasetPath(entry.path, taskId);
  try {
    const cached = await readFile(destination);
    if (verifyAsset(cached, entry)) return cached;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const data = await fetchBuffer(fileUrl(entry.path));
  if (!verifyAsset(data, entry)) throw new Error(`Pinned asset checksum mismatch: ${entry.path}`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  downloaded += 1;
  return data;
}

await mkdir(cacheDir, { recursive: true });
const { value: revision } = await fetchJson(`${DATASET_API_ROOT}/revision/${DATASET_REVISION}`);
if (revision.sha !== DATASET_REVISION) {
  throw new Error(`Dataset revision mismatch: expected ${DATASET_REVISION}, received ${revision.sha ?? "unknown"}`);
}

const manifest = await fetchBuffer(TASKS_URL);
if (sha256(manifest) !== TASK_MANIFEST_SHA256) {
  throw new Error("Pinned WebForge task manifest checksum mismatch");
}
const allTasks = parseJsonLines(manifest.toString("utf8"));
const assessments = new Map();
const trees = new Map();
const rejected = [];

for (let domain = 1; domain <= 7; domain += 1) {
  for (let level = 1; level <= 3; level += 1) {
    for (const task of trackCandidates(allTasks, domain, level)) {
      const files = await fetchTaskTree(task.id);
      trees.set(task.id, files);
      const declaredPath = `websites${task.url}`;
      if (!declaredPath.startsWith(`websites/${task.id}/`) || !files.some((entry) => entry.path === declaredPath)) {
        assessments.set(task.id, false);
        rejected.push({ taskId: task.id, domain: task.domain, level: task.level, reason: "missing-start-page" });
        continue;
      }

      let externalReference = null;
      for (const entry of files.filter((item) => isTextAsset(item.path))) {
        const data = await ensureAsset(entry, task.id);
        const [url] = findExternalUrls(data.toString("utf8"));
        if (url) {
          externalReference = { path: entry.path, url };
          break;
        }
      }
      if (externalReference) {
        assessments.set(task.id, false);
        rejected.push({
          taskId: task.id,
          domain: task.domain,
          level: task.level,
          reason: "external-url",
          ...externalReference,
        });
        continue;
      }

      assessments.set(task.id, true);
      break;
    }
  }
}

const selected = selectTrack(allTasks, (task) => assessments.get(task.id) === true);
const frozenTrack = JSON.parse(await readFile(resolve(BENCHMARK_DIR, "track.json"), "utf8"));
const selectedIds = selected.map((task) => task.id);
if (frozenTrack.track !== TRACK_ID
  || frozenTrack.datasetRevision !== DATASET_REVISION
  || frozenTrack.selectionSeed !== SELECTION_SEED
  || JSON.stringify(frozenTrack.taskIds) !== JSON.stringify(selectedIds)) {
  throw new Error("Derived WebForge selection does not match the checked-in frozen track");
}
const selectedFiles = selected.flatMap((task) => trees.get(task.id).map((entry) => ({ entry, taskId: task.id })));
const totalFiles = selectedFiles.length;
let completed = 0;
const workers = Array.from({ length: Math.min(3, totalFiles) }, async () => {
  while (selectedFiles.length > 0) {
    const job = selectedFiles.shift();
    await ensureAsset(job.entry, job.taskId);
    completed += 1;
    if (completed % 25 === 0 || completed === totalFiles) {
      console.log(`Website assets: ${completed}/${totalFiles} checked, ${downloaded} downloaded`);
    }
  }
});
await Promise.all(workers);

const lockedFiles = selected
  .flatMap((task) => trees.get(task.id))
  .sort((left, right) => left.path.localeCompare(right.path))
  .map((entry) => ({ path: entry.path, ...assetIntegrity(entry) }));
const assetBytes = lockedFiles.reduce((sum, entry) => sum + entry.size, 0);
if (frozenTrack.assetCount !== lockedFiles.length || frozenTrack.assetBytes !== assetBytes) {
  throw new Error("Pinned WebForge asset inventory does not match the checked-in frozen track");
}
const runnerTasks = selected.map(sanitizeTask);
const answers = Object.fromEntries(selected.map((task) => [task.id, expectedHash(task.ground_truth)]));
const selection = {
  version: 2,
  track: TRACK_ID,
  datasetRevision: DATASET_REVISION,
  selectionSeed: SELECTION_SEED,
  criterion: "First hash-ranked task per domain/level with a valid start page and no external URL literals in text assets.",
  rejected,
  assetCount: lockedFiles.length,
  assetBytes,
  tasks: runnerTasks,
};
const answersContents = `${JSON.stringify(answers, null, 2)}\n`;
const assetLockContents = `${JSON.stringify({
  version: 1,
  datasetRevision: DATASET_REVISION,
  files: lockedFiles,
}, null, 2)}\n`;
const selectionContents = `${JSON.stringify(selection, null, 2)}\n`;
if (sha256(answersContents) !== frozenTrack.answerHashesSha256
  || sha256(assetLockContents) !== frozenTrack.assetLockSha256
  || sha256(selectionContents) !== frozenTrack.selectionSha256) {
  throw new Error("Derived WebForge cache metadata does not match the checked-in integrity anchors");
}

await writeFile(resolve(cacheDir, "tasks.runner.jsonl"), `${runnerTasks.map((task) => JSON.stringify(task)).join("\n")}\n`);
const answersPath = resolve(cacheDir, "answers.sha256.json");
await writeFile(answersPath, answersContents, { mode: 0o600 });
await chmod(answersPath, 0o600);
await writeFile(resolve(cacheDir, "assets.lock.json"), assetLockContents);
await writeFile(resolve(cacheDir, "selection.json"), selectionContents);

console.log(`Prepared ${selected.length} blind WebForge tasks in ${cacheDir}`);
console.log(`Verified ${lockedFiles.length} pinned website files; downloaded ${downloaded}.`);
