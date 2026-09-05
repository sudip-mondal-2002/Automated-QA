import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { replayStatus } from "./replay.js";

export const HISTORY_CONTRACT_VERSION = 2;
export const HISTORY_PROMPT_VERSION = "planner-v3-neutral-partitioned";
export const HISTORY_CRAWLER_VERSION = "crawl-v2-parallel-bfs";
export const HISTORY_GENERATOR_VERSION = "generator-v2-target-isolated";
export const HISTORY_SCHEMA_VERSION = "plan-draft-v2-predicates";

const STOP_WORDS = new Set([
  "a", "an", "and", "at", "be", "by", "do", "for", "from", "given", "in", "is", "it",
  "of", "on", "or", "please", "that", "the", "then", "this", "to", "use", "verify", "with",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function historyHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function objectiveTerms(value, { sensitiveValues = [] } = {}) {
  const sensitive = new Set(sensitiveValues
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .flatMap((entry) => [String(entry).toLowerCase(), ...(String(entry).toLowerCase().match(/[a-z0-9]+/g) ?? [])]));
  return [...new Set(String(value ?? "")
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{2,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term) && !sensitive.has(term) && !/^\d+$/.test(term))
    .sort();
}

export function createHistoryRequest({
  target,
  prompt = "",
  prd = { requirements: [] },
  plannerMode = "deterministic",
  maxPages = 25,
  maxDepth = 3,
  appRevision = "unknown",
  authScope = "anonymous",
  crawlerVersion = HISTORY_CRAWLER_VERSION,
  generatorVersion = HISTORY_GENERATOR_VERSION,
  schemaVersion = HISTORY_SCHEMA_VERSION,
  sensitiveValues = [],
} = {}) {
  const origin = new URL(target).origin;
  const terms = objectiveTerms(prompt, { sensitiveValues });
  const identity = {
    contractVersion: HISTORY_CONTRACT_VERSION,
    promptVersion: HISTORY_PROMPT_VERSION,
    target: origin,
    objectiveTerms: terms,
    prdHash: historyHash(prd?.requirements ?? []),
    plannerMode,
    maxPages,
    maxDepth,
    appRevision,
    authScope,
    crawlerVersion,
    generatorVersion,
    schemaVersion,
  };
  return {
    version: HISTORY_CONTRACT_VERSION,
    ...identity,
    fingerprint: historyHash(identity),
  };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function orchestrationRoot(workspace) {
  return path.join(workspace.runsDirectory, "orchestrations");
}

function replayVariables(script = "") {
  return [...new Set([...String(script).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]))].sort();
}

export async function saveHistoryManifest({ directory, request, orchestrationId, artifacts, now = () => new Date() }) {
  const at = now instanceof Date ? now : now();
  const manifest = {
    ...request,
    orchestrationId,
    createdAt: (at instanceof Date ? at : new Date(at)).toISOString(),
    artifacts,
  };
  await writeFile(path.join(directory, "request.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function exactOrchestrationHit({ workspace, request, excludeDirectory }) {
  const root = orchestrationRoot(workspace);
  if (!(await exists(root))) return null;
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((entry) => path.resolve(entry) !== path.resolve(excludeDirectory ?? ""));
  const candidates = (await Promise.all(entries.map(async (directory) => {
    const manifestPath = path.join(directory, "request.json");
    try {
      const manifest = await readJson(manifestPath);
      return manifest.fingerprint === request.fingerprint ? { directory, manifest } : null;
    } catch {
      // Invalid history is ignored rather than becoming executable input.
      return null;
    }
  }))).filter(Boolean);
  candidates.sort((left, right) => String(right.manifest.createdAt).localeCompare(String(left.manifest.createdAt)));
  for (const candidate of candidates) {
    const specIds = candidate.manifest.artifacts?.specIds ?? [];
    if (specIds.length === 0) continue;
    try {
      const [plan, gaps, specs] = await Promise.all([
        readJson(path.join(candidate.directory, candidate.manifest.artifacts.plan ?? "test-plan.json")),
        readJson(path.join(candidate.directory, candidate.manifest.artifacts.gaps ?? "gaps.json")),
        Promise.all(specIds.map((id) => workspace.loadSpec(id))),
      ]);
      const replay = await Promise.all(specs.map(async (spec) => {
        const status = await replayStatus(workspace, spec.id, spec.environment);
        return { specId: spec.id, state: status.state, sourceHash: status.manifest?.sourceHash, scriptHash: status.manifest?.scriptHash, requiredVariables: replayVariables(status.script) };
      }));
      let siteMap;
      try { siteMap = await readJson(path.join(candidate.directory, candidate.manifest.artifacts.siteMap ?? "site-map.json")); } catch {}
      return { kind: "exact", ...candidate, plan, gaps, specs, replay, siteMap };
    } catch {
      // A manifest is a hint; missing or invalid artifacts make it unusable.
    }
  }
  return null;
}

function specSearchText(spec) {
  return [
    spec.id,
    spec.title,
    ...(spec.steps ?? []).flatMap((step) => [step.intent, ...(step.expect ?? [])]),
    ...(spec.fixtures?.before ?? []),
    ...(spec.fixtures?.after ?? []),
  ].join(" ");
}

export function similarityScore(queryTerms, candidateTerms) {
  const query = new Set(queryTerms);
  const candidate = new Set(candidateTerms);
  if (query.size === 0 || candidate.size === 0) return 0;
  const intersection = [...query].filter((term) => candidate.has(term)).length;
  // Sørensen-Dice rewards shared intent while penalizing both an incomplete
  // match and an overly broad candidate. The old minimum-size denominator
  // gave a perfect score when a one-word candidate matched one word in a long
  // objective, which was too permissive for executable recommendations.
  return Math.round(((2 * intersection) / (query.size + candidate.size)) * 1000) / 1000;
}

export async function findSemanticSpecHistory({ workspace, request, limit = 5 } = {}) {
  let environments;
  let specs;
  let priorResults;
  try {
    [environments, specs, priorResults] = await Promise.all([
      workspace.loadEnvironments().then((document) => document.environments),
      workspace.listSpecs(),
      workspace.listResults(),
    ]);
  } catch {
    return [];
  }
  const latestBySpec = new Map();
  for (const result of priorResults) {
    if (!latestBySpec.has(result.specId)) latestBySpec.set(result.specId, result);
  }
  const scored = [];
  for (const spec of specs) {
    const environment = environments?.[spec.environment];
    if (environment?.type !== "web") continue;
    let environmentOrigin;
    try { environmentOrigin = new URL(environment.baseUrl).origin; } catch { continue; }
    if (environmentOrigin !== request.target) continue;
    const terms = objectiveTerms(specSearchText(spec));
    const score = similarityScore(request.objectiveTerms, terms);
    if (score === 0) continue;
    scored.push({ spec, score });
  }
  const results = await Promise.all(scored.map(async ({ spec, score }) => {
    const replay = await replayStatus(workspace, spec.id, spec.environment);
    const prior = latestBySpec.get(spec.id);
    return {
      specId: spec.id,
      title: spec.title,
      environment: spec.environment,
      score,
      replayState: replay.state,
      sourceHash: replay.manifest?.sourceHash,
      scriptHash: replay.manifest?.scriptHash,
      requiredVariables: replayVariables(replay.script),
      lastClassification: prior?.classification,
      lastRunId: prior?.runId,
    };
  }));
  return results
    .sort((left, right) => right.score - left.score || Number(right.replayState === "trusted") - Number(left.replayState === "trusted") || left.specId.localeCompare(right.specId))
    .slice(0, limit);
}

export async function resolveHistory({ workspace, request, excludeDirectory, includeSimilar = true } = {}) {
  const exact = await exactOrchestrationHit({ workspace, request, excludeDirectory });
  if (exact) return exact;
  const candidates = includeSimilar ? await findSemanticSpecHistory({ workspace, request }) : [];
  return { kind: candidates.length > 0 ? "similar" : "miss", candidates };
}
