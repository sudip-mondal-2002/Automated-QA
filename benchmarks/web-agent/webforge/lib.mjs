import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");
export const BENCHMARK_DIR = resolve(ROOT, "benchmarks/web-agent/webforge");
export const DEFAULT_CACHE_DIR = resolve(ROOT, ".benchmark-cache/webforge");
export const RUNS_DIR = resolve(ROOT, "artifacts/benchmarks/webforge/runs");

export const SOURCE_REVISION = "ca0cf9fc8d5ab9cac34c1d4387018600e0f1849e";
export const DATASET_REVISION = "56e0903f9205577cf39a4253bb0fc163fdb3cbd5";
export const TASK_MANIFEST_SHA256 = "72f85e83427cecfb4aea344fd5309f23a1498dcf2c6b70a5f19eb772c234272b";
export const SELECTION_SEED = "auto-qa-webforge-op21-v1";
export const TRACK_ID = "operation-code-21-v2";
export const TASKS_URL = `https://huggingface.co/datasets/yuandaxia/WebForge/resolve/${DATASET_REVISION}/tasks.jsonl`;
export const DATASET_API_ROOT = "https://huggingface.co/api/datasets/yuandaxia/WebForge";
export const DATASET_RESOLVE_ROOT = "https://huggingface.co/datasets/yuandaxia/WebForge/resolve";

const PROTOCOL_PATHS = [
  ".gitignore",
  "package.json",
  "benchmarks/web-agent/webforge/lib.mjs",
  "benchmarks/web-agent/webforge/prepare.mjs",
  "benchmarks/web-agent/webforge/protocol.mjs",
  "benchmarks/web-agent/webforge/publish.mjs",
  "benchmarks/web-agent/webforge/record.mjs",
  "benchmarks/web-agent/webforge/score.mjs",
  "benchmarks/web-agent/webforge/serve.mjs",
  "benchmarks/web-agent/webforge/verify.mjs",
  "benchmarks/web-agent/webforge/provenance.json",
  "benchmarks/web-agent/webforge/track.json",
];

const TEXT_ASSET_PATTERN = /\.(?:css|htm|html|js|json|svg|txt|xml)$/i;
const EXTERNAL_URL_PATTERN = /(?:https?:)?\/\/[^\s"'`<>\\)\]}]+/gi;
const NON_FETCHING_URLS = new Set([
  "http://www.w3.org/",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/2001/xmlschema-instance",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeOperationCode(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

export function expectedHash(value) {
  return sha256(normalizeOperationCode(value));
}

export function resolveCommittedRevision(value, name = "revision") {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) {
    throw new Error(`--${name} must be a full 40-character lowercase Git commit`);
  }
  let resolved;
  try {
    resolved = execFileSync("git", ["rev-parse", "--verify", `${value}^{commit}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`--${name} does not resolve to a local Git commit: ${value}`);
  }
  if (resolved !== value) throw new Error(`--${name} must name the resolved commit exactly`);
  return resolved;
}

export function currentCleanProtocolRevision() {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...PROTOCOL_PATHS],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  if (status) {
    throw new Error(`Commit benchmark protocol changes before recording or publishing:\n${status}`);
  }
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

export function validateTaskOrigin(value, taskId) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid task origin: ${value ?? ""}`);
  }
  if (url.protocol !== "http:"
    || url.hostname !== `${taskId}.localhost`
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password) {
    throw new Error(`Task origin must be http://${taskId}.localhost:<port>`);
  }
  return url.origin;
}

export function gitBlobSha1(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
}

export function assetIntegrity(entry) {
  if (!entry || entry.type !== "file" || !Number.isInteger(entry.size) || entry.size < 0) {
    throw new Error(`Invalid dataset file metadata: ${entry?.path ?? "unknown"}`);
  }
  if (entry.lfs?.oid) {
    if (entry.lfs.size !== entry.size || !/^[a-f0-9]{64}$/.test(entry.lfs.oid)) {
      throw new Error(`Invalid LFS metadata: ${entry.path}`);
    }
    return { algorithm: "sha256", digest: entry.lfs.oid, size: entry.size };
  }
  if (entry.oid) {
    if (!/^[a-f0-9]{40}$/.test(entry.oid)) throw new Error(`Invalid Git blob metadata: ${entry.path}`);
    return { algorithm: "git-blob-sha1", digest: entry.oid, size: entry.size };
  }
  throw new Error(`Dataset file has no content digest: ${entry.path}`);
}

export function verifyLockedAsset(value, lock) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!lock || !Number.isInteger(lock.size) || lock.size < 0 || buffer.length !== lock.size) return false;
  if (lock.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(lock.digest ?? "")) {
    return sha256(buffer) === lock.digest;
  }
  if (lock.algorithm === "git-blob-sha1" && /^[a-f0-9]{40}$/.test(lock.digest ?? "")) {
    return gitBlobSha1(buffer) === lock.digest;
  }
  return false;
}

export function evidenceMedia(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  throw new Error("Evidence must be a PNG, JPEG, or WebP image");
}

export function verifyAsset(value, entry) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const integrity = assetIntegrity(entry);
  if (buffer.length !== integrity.size) return false;
  const actual = integrity.algorithm === "sha256" ? sha256(buffer) : gitBlobSha1(buffer);
  return actual === integrity.digest;
}

export function isTextAsset(path) {
  return TEXT_ASSET_PATTERN.test(path);
}

export function findExternalUrls(value) {
  const text = String(value).replaceAll("\\/", "/");
  return [...text.matchAll(EXTERNAL_URL_PATTERN)]
    .map((match) => match[0].replace(/[.,;:!?]+$/g, ""))
    .filter((url) => !NON_FETCHING_URLS.has(url.toLowerCase()));
}

export function trackCandidates(tasks, domain, level) {
  return tasks
    .filter((task) => task.answer_type === "operation_code"
      && task.is_stochastic === false
      && task.domain === `domain_${domain}`
      && task.level === level)
    .sort((left, right) => sha256(`${SELECTION_SEED}:${left.id}`)
      .localeCompare(sha256(`${SELECTION_SEED}:${right.id}`)));
}

export function selectTrack(tasks, isAvailable = () => true) {
  const selected = [];
  for (let domain = 1; domain <= 7; domain += 1) {
    for (let level = 1; level <= 3; level += 1) {
      const candidates = trackCandidates(tasks, domain, level);
      const candidate = candidates.find(isAvailable);
      if (!candidate) {
        throw new Error(`WebForge manifest has no available deterministic operation-code task for domain_${domain}/L${level}`);
      }
      selected.push(candidate);
    }
  }
  return selected;
}

export function sanitizeTask(task) {
  const { ground_truth: _groundTruth, ...safe } = task;
  return safe;
}

export function parseJsonLines(contents) {
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

export function assertSafeId(value, name = "id") {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value ?? "")) {
    throw new Error(`Invalid ${name}: ${value ?? ""}`);
  }
  return value;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function wilson95(successes, total) {
  if (total === 0) return [0, 0];
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function summarize(cases, tasks) {
  const byId = new Map(cases.map((entry) => [entry.taskId, entry]));
  const rows = tasks.map((task) => {
    const result = byId.get(task.id);
    return {
      taskId: task.id,
      domain: task.domain,
      domainName: task.domain_name,
      level: task.level,
      attempted: Boolean(result),
      correct: result?.correct === true,
      actions: result?.actions ?? null,
      elapsedSeconds: result?.elapsedSeconds ?? null,
      evidence: Boolean(result?.evidence),
    };
  });
  const grouped = (key) => Object.values(rows.reduce((acc, row) => {
    const group = String(key(row));
    acc[group] ??= { key: group, correct: 0, total: 0 };
    acc[group].total += 1;
    acc[group].correct += Number(row.correct);
    return acc;
  }, {})).map((group) => ({ ...group, accuracy: group.correct / group.total }));
  const correct = rows.filter((row) => row.correct).length;
  const attempted = rows.filter((row) => row.attempted).length;
  const [ciLow, ciHigh] = wilson95(correct, rows.length);
  return {
    track: TRACK_ID,
    correct,
    attempted,
    total: rows.length,
    accuracy: correct / rows.length,
    ci95: { low: ciLow, high: ciHigh },
    meanActions: attempted
      ? rows.filter((row) => row.attempted).reduce((sum, row) => sum + row.actions, 0) / attempted
      : 0,
    meanElapsedSeconds: attempted
      ? rows.filter((row) => row.attempted).reduce((sum, row) => sum + row.elapsedSeconds, 0) / attempted
      : 0,
    evidenceCoverage: attempted
      ? rows.filter((row) => row.attempted && row.evidence).length / attempted
      : 0,
    byLevel: grouped((row) => `L${row.level}`),
    byDomain: grouped((row) => row.domain),
    cases: rows,
  };
}

export function renderReport(summary) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  return [
    `# WebForge-Bench — ${summary.runId}`,
    "",
    `- Track: \`${summary.track}\``,
    `- Score: **${summary.correct}/${summary.total} (${pct(summary.accuracy)})**`,
    `- Attempted: ${summary.attempted}/${summary.total}; missing cases count as incorrect`,
    `- Wilson score interval under a ${summary.total}-case binomial model: ${pct(summary.ci95.low)}–${pct(summary.ci95.high)}; this deterministic stratified sample does not support inference to the 934-task suite`,
    `- Mean runner-reported browser actions (attempted cases): ${summary.meanActions.toFixed(1)}`,
    `- Mean runner-reported elapsed time (attempted cases): ${summary.meanElapsedSeconds.toFixed(1)} seconds`,
    `- Final-screenshot file coverage: ${summary.attempted}/${summary.total} (${pct(summary.evidenceCoverage)}); file presence does not constitute independent visual adjudication`,
    `- Dataset revision: \`${summary.datasetRevision}\``,
    `- Pinned assets: ${summary.assetCount} files / ${summary.assetBytes} bytes`,
    "",
    "## By difficulty",
    "",
    "| Level | Correct | Total | Accuracy |",
    "| --- | ---: | ---: | ---: |",
    ...summary.byLevel.map((group) => `| ${group.key} | ${group.correct} | ${group.total} | ${pct(group.accuracy)} |`),
    "",
    "## By domain",
    "",
    "| Domain | Correct | Total | Accuracy |",
    "| --- | ---: | ---: | ---: |",
    ...summary.byDomain.map((group) => `| ${group.key} | ${group.correct} | ${group.total} | ${pct(group.accuracy)} |`),
    "",
    "This is the fixed 21-task offline-native operation-code track, not the full 934-task WebForge leaderboard suite.",
    "",
  ].join("\n");
}
