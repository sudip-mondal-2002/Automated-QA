import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { QaError } from "./errors.js";
import { createTracer } from "./trace.js";
import { buildTestPlan, crawl, parsePrd, renderTestPlanMarkdown, replan } from "./planner.js";
import { planWithParallelAgents } from "./planner-agent.js";
import { validateDocument } from "./schema-validator.js";
import { decideVerdict, evaluatePlan, renderGapsMarkdown } from "./coverage.js";
import { generate } from "./generator.js";
import { executeWithReplay } from "./replay.js";
import { buildReport, writeReport } from "./reporter.js";
import { QaWorkspace } from "./storage.js";
import { stringifyYaml } from "./documents.js";
import { createHistoryRequest, historyHash, resolveHistory, saveHistoryManifest } from "./history.js";

export const EXIT = Object.freeze({ OK: 0, DEFECTS: 10, ESCALATED: 11, UNVALIDATED: 12, UNREACHABLE: 20, USAGE: 30, INTERNAL: 40 });
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const DESTRUCTIVE = /\b(checkout|create|delete|pay|place|purchase|register|remove|save|submit|update|upload|write)\b/i;
export const MAX_EXECUTION_CONCURRENCY = 8;
const execFileAsync = promisify(execFile);

function timestamp(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function durationSince(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function targetIdentity(origin) {
  const suffix = historyHash(origin).slice(0, 10);
  return { environment: `target-${suffix}`, specPrefix: `target-${suffix}` };
}

export async function resolveApplicationRevision(root, explicit = "auto") {
  if (explicit && explicit !== "auto") return String(explicit);
  try {
    const options = { cwd: root, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 };
    const untrackedPromise = execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], options)
      .then(async ({ stdout }) => Promise.all(String(stdout).split("\0")
        .filter((file) => file && file !== ".qa" && !file.startsWith(".qa/"))
        .sort()
        .map(async (file) => {
          const contents = await readFile(path.join(root, file));
          return [file, createHash("sha256").update(contents).digest("hex")];
        })));
    const [{ stdout: head }, { stdout: workingDiff }, { stdout: stagedDiff }, { stdout: status }, untracked] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], options),
      execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "--", ".", ":(exclude).qa"], options),
      execFileAsync("git", ["diff", "--cached", "--binary", "--no-ext-diff", "--", ".", ":(exclude).qa"], options),
      execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal", "--", ".", ":(exclude).qa"], options),
      untrackedPromise,
    ]);
    return historyHash({ head: head.trim(), workingDiff, stagedDiff, status, untracked });
  } catch {
    // Never make two unresolved revisions exact-cache compatible by accident.
    // Non-git or unusually large applications can opt in with --app-revision.
    return `unresolved:${randomUUID()}`;
  }
}

function runResource(spec) {
  const text = (spec.steps ?? []).map((step) => step.intent).join(" ");
  const fixtures = [
    ...(spec.fixtures?.before ?? []),
    ...(spec.fixtures?.after ?? []),
    ...(spec.fixtures?.between ?? []).flatMap((entry) => entry.fixtures ?? []),
  ];
  return DESTRUCTIVE.test(text) || fixtures.length > 0 ? "shared-mutable-application" : `isolated-${spec.id}`;
}

/** Bounded worker pool with a serial lock for shared/destructive application state. */
export async function runWithResourceLocks(items, { concurrency = 1, resource = () => "shared", worker } = {}) {
  const limit = Math.max(1, Math.min(Number.isInteger(concurrency) ? concurrency : 1, MAX_EXECUTION_CONCURRENCY, items.length || 1));
  let active = 0;
  const waiting = [];
  const acquire = async () => {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  const tails = new Map();
  const output = new Array(items.length);
  const tasks = items.map((item, index) => {
    const key = resource(item);
    const prior = tails.get(key) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      await acquire();
      try {
        output[index] = await worker(item, index);
      } finally {
        release();
      }
    });
    tails.set(key, task);
    return task;
  });
  await Promise.all(tasks);
  return output;
}

/** Parallel fallback is safe only when every worker can own its executor. */
export function executionConcurrencyFor({ requested = 1, specs = [], replayStates = {}, executor, executorFactory } = {}) {
  const allTrusted = specs.length > 0 && specs.every((spec) => replayStates[spec.id] === "trusted");
  const isolatedExecutors = typeof executorFactory === "function";
  const replayOnly = allTrusted && !executor;
  const bounded = Math.max(1, Math.min(Number.isInteger(requested) ? requested : 1, MAX_EXECUTION_CONCURRENCY));
  return { allTrusted, isolatedExecutors, concurrency: isolatedExecutors || replayOnly ? bounded : 1 };
}

export function assertTargetAllowed(target, { allowRemote = false } = {}) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new QaError("ORCHESTRATION_TARGET_UNREACHABLE", `Invalid target URL: ${target}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new QaError("ORCHESTRATION_TARGET_UNREACHABLE", "Only http and https targets are supported");
  }
  if (!allowRemote && !LOOPBACK.has(parsed.hostname)) {
    throw new QaError("ORCHESTRATION_REMOTE_BLOCKED", "Remote targets require --allow-remote");
  }
  return parsed;
}

function generationSummary(generation, specIds = []) {
  const assertions = generation?.assertions ?? { checked: 0, verified: 0, refuted: 0, withPredicates: 0, total: 0 };
  return {
    specs: generation?.specs ?? specIds.length,
    validated: generation?.validated ?? specIds.length,
    unvalidated: generation?.unvalidated ?? 0,
    strategies: generation?.strategies ?? {},
    assertions,
    artifacts: specIds,
    flowMap: generation?.flowMap ?? {},
    replayStates: generation?.replayStates ?? {},
  };
}

function runRow({ spec, result, flowId, durationMs, reused }) {
  const classification = result.classification;
  const status = classification === "passed" ? "passed" : classification === "healed" ? "healed" : classification === "blocked" ? "blocked" : "failed";
  const healedHere = (result.steps ?? []).some((step) => step.healing?.outcome === "healed");
  const triaged = status === "failed" ? "app_defect" : status === "blocked" ? "environment" : healedHere ? "broken_locator" : "none";
  return {
    flowId,
    specId: spec.id,
    status,
    classification: triaged,
    confidence: status === "failed" ? 0.7 : status === "blocked" ? 0.95 : 0.9,
    durationMs,
    specFile: reused ? `.qa/specs/${spec.id}.yaml` : `generated/${spec.id}.spec.js`,
    runId: result.runId,
    runClassification: classification,
    screenshots: result.evidence?.screenshots ?? [],
    heals: (result.steps ?? []).flatMap((step) => step.healing ? [{ stepIndex: step.index, from: step.healing.originalFailure, to: step.healing.replacement, promoted: step.healing.outcome === "healed", succeeded: step.healing.outcome === "healed" }] : []),
    ...(status === "blocked" ? { blockedReason: result.explanation } : {}),
  };
}

export async function orchestrate({
  url,
  username,
  password,
  prompt = "",
  prdText,
  outDir,
  root = process.cwd(),
  maxReplans = 2,
  maxPages = 25,
  maxDepth = 3,
  crawlConcurrency = 4,
  allowRemote = false,
  fetchImpl = globalThis.fetch,
  executor,
  executorFactory,
  executionConcurrency = 3,
  variables = process.env,
  now = () => new Date(),
  emit,
  planner,
  planningConcurrency = 3,
  plannerAttempts = 2,
  planOnly = false,
  browserLauncher,
  historyMode = "lookup",
  appRevision = "auto",
} = {}) {
  if (!url) throw new QaError("ORCHESTRATION_TARGET_UNREACHABLE", "--url is required");
  const parsed = assertTargetAllowed(url, { allowRemote });
  const startedAt = timestamp(now);
  const orchestrationId = `orch_${Date.parse(startedAt)}_${randomUUID().slice(0, 8)}`;
  const workspace = new QaWorkspace(root);
  await workspace.ensureDirectories();
  const directory = outDir ?? path.join(workspace.qaDirectory, "runs", "orchestrations", orchestrationId);
  await mkdir(directory, { recursive: true });
  const secretVariableValues = Object.entries(variables ?? {})
    .filter(([key, value]) => /password|secret|token|card/i.test(key) && typeof value === "string")
    .map(([, value]) => value);
  const tracer = createTracer({
    now,
    sensitiveValues: [password, username, ...secretVariableValues].filter((value) => typeof value === "string" && value.length > 3),
    writeLine: async (line) => { await writeFile(path.join(directory, "trace.jsonl"), line, { flag: "a" }); },
  });
  const say = async (stage, event, payload) => {
    const traced = await tracer.emit(stage, event, payload);
    if (emit) await emit(stage, event, payload);
    return traced;
  };

  const decisions = [];
  const gapsHistory = [];
  const heals = [];
  const runs = [];
  const prdParsed = prdText !== undefined ? parsePrd(prdText) : { requirements: [] };
  const identity = targetIdentity(parsed.origin);
  const plannerValueReferences = [...new Set([
    ...Object.keys(variables ?? {}).filter((key) => /^QA_[A-Z0-9_]+$/.test(key)),
    ...(username ? ["QA_USERNAME", "QA_CUSTOMER_USERNAME"] : []),
    ...(password ? ["QA_PASSWORD", "QA_CUSTOMER_PASSWORD"] : []),
  ])].sort().map((key) => `\${${key}}`);
  const resolvedAppRevision = await resolveApplicationRevision(root, appRevision);
  const request = createHistoryRequest({
    target: parsed.origin,
    prompt,
    prd: prdParsed,
    plannerMode: planner ? "agent" : "deterministic",
    maxPages,
    maxDepth,
    appRevision: resolvedAppRevision,
    authScope: username && password ? "authenticated" : "anonymous",
    sensitiveValues: [username, password],
  });
  let history = { kind: "miss", candidates: [] };

  try {
    if (planner) await say("bootstrap", "planner_ready", { message: "Planner capability provided by the host" });

    const memoryStarted = performance.now();
    await say("memory", "stage_started", { message: "Resolving source-compatible orchestration history" });
    if (historyMode !== "off") history = await resolveHistory({ workspace, request, excludeDirectory: directory });
    await say("memory", history.kind === "exact" ? "history_hit" : history.kind === "similar" ? "history_similar" : "history_miss", {
      message: history.kind === "exact"
        ? `Exact history ${history.manifest.orchestrationId}: ${history.specs.length} spec(s), ${history.replay.filter((entry) => entry.state === "trusted").length} trusted replay(s)`
        : history.kind === "similar"
          ? `${history.candidates.length} semantic candidate(s); similarity is not executable equivalence`
          : historyMode === "off" ? "History lookup disabled" : "No compatible history",
      data: {
        durationMs: durationSince(memoryStarted),
        fingerprint: request.fingerprint,
        ...(history.kind === "exact" ? { sourceOrchestrationId: history.manifest.orchestrationId, replay: history.replay } : {}),
        ...(history.kind === "similar" ? { candidates: history.candidates.map(({ specId, score, replayState }) => ({ specId, score, replayState })) } : {}),
      },
    });
    decisions.push({ seq: decisions.length + 1, stage: "memory", decision: history.kind, reason: history.kind === "exact" ? `source-compatible artifacts from ${history.manifest.orchestrationId}` : history.kind === "similar" ? "similar history retained as a non-executable hint" : "cold workflow required", at: timestamp(now) });

    const probeStarted = performance.now();
    await say("probe", "stage_started", { message: `Probing ${parsed.href}` });
    let probeOk = false;
    let initialPage;
    try {
      const response = await fetchImpl(parsed.href, { method: "GET", redirect: "manual" });
      probeOk = response.status < 500;
      if (probeOk && history.kind !== "exact" && typeof response.text === "function") {
        try {
          initialPage = { path: parsed.pathname || "/", response, html: await response.text() };
        } catch {
          initialPage = undefined;
        }
      }
    } catch {
      probeOk = false;
    }
    if (!probeOk) throw new QaError("ORCHESTRATION_TARGET_UNREACHABLE", `Target unreachable: ${parsed.origin}`);
    await say("probe", "stage_completed", { message: "Target reachable", data: { durationMs: durationSince(probeStarted) } });

    let siteMap;
    let plan;
    let gaps;
    let verdict = "pass";
    let generation;

    if (history.kind === "exact") {
      siteMap = history.siteMap ?? { version: 1, origin: parsed.origin, crawledAt: startedAt, authenticated: false, auth: { attempted: false, authenticated: false }, degraded: true, pages: [] };
      plan = validateDocument("testPlan", history.plan);
      gaps = validateDocument("gaps", history.gaps);
      gapsHistory.push(gaps);
      generation = generationSummary(history.manifest.artifacts?.generation, history.specs.map((spec) => spec.id));
      await mkdir(path.join(directory, "generated"), { recursive: true });
      await writeJson(path.join(directory, "generated", "reused.json"), { sourceOrchestrationId: history.manifest.orchestrationId, specs: history.replay });
    } else {
      const credentials = username && password ? { username, password } : undefined;
      const planStarted = performance.now();
      await say("plan", "stage_started", { message: "Crawling target once for evidence" });
      siteMap = await crawl({ url: parsed.href, credentials, fetchImpl, initialPage, maxPages, maxDepth, concurrency: crawlConcurrency, emit: say, now });
      validateDocument("siteMap", siteMap);
      plan = planner
        ? await planWithParallelAgents({ planner, siteMap, prompt, prd: prdParsed, attempts: plannerAttempts, maxWorkers: planningConcurrency, valueReferences: plannerValueReferences, emit: say, now })
        : { ...buildTestPlan({ siteMap, prompt, prd: prdParsed, now }), source: { planner: "deterministic", fellBack: false } };
      let attempt = 1;
      let previousScore;
      gaps = evaluatePlan({ plan, siteMap, prd: prdParsed, prompt });
      gapsHistory.push(gaps);
      verdict = decideVerdict({ checklist: withGaps(gaps), attempt, maxReplans, prevScore: previousScore, score: gaps.score });
      decisions.push({ seq: decisions.length + 1, stage: "gate", decision: verdict, reason: `score ${gaps.score}, attempt ${attempt}/${maxReplans}`, at: timestamp(now) });
      await say("gate", "decision", { message: `${verdict} at ${gaps.score}` });
      while (verdict === "replan" && attempt < maxReplans) {
        previousScore = gaps.score;
        plan = replan({ plan, gaps, siteMap, now });
        attempt += 1;
        gaps = evaluatePlan({ plan, siteMap, prd: prdParsed, prompt });
        gapsHistory.push(gaps);
        verdict = decideVerdict({ checklist: withGaps(gaps), attempt, maxReplans, prevScore: previousScore, score: gaps.score });
        decisions.push({ seq: decisions.length + 1, stage: "gate", decision: verdict, reason: `score ${gaps.score} vs prev ${previousScore}`, at: timestamp(now) });
        await say("gate", "replan_triggered", { message: `attempt ${attempt}: ${gaps.score}` });
      }
      validateDocument("testPlan", plan);
      validateDocument("gaps", gaps);
      await say("plan", "stage_completed", { message: `${plan.flows.length} flow(s)`, data: { durationMs: durationSince(planStarted) } });
    }

    if (siteMap) await writeJson(path.join(directory, "site-map.json"), siteMap);
    await writeJson(path.join(directory, "test-plan.json"), plan);
    await writeFile(path.join(directory, "test-plan.md"), renderTestPlanMarkdown(plan));
    await writeJson(path.join(directory, "gaps.json"), gaps);
    await writeFile(path.join(directory, "gaps.md"), renderGapsMarkdown(gaps));

    if (planOnly || verdict === "escalate") {
      const reason = planOnly ? `Stopping after planning: ${plan.flows.length} flows, score ${gaps.score}` : `Coverage gate escalated at score ${gaps.score}; execution was not authorized`;
      await say("plan", planOnly ? "plan_only" : "execution_escalated", { message: reason });
      const report = buildReport({ plan, gapsHistory, generation: {}, runs: [], heals: [], decisions, prd: prdParsed, startedAt, finishedAt: timestamp(now), orchestrationId, target: parsed.origin });
      await writeReport({ outDir: directory, report, emit: say });
      return { report, plan, gaps, history, exitCode: planOnly ? EXIT.UNVALIDATED : EXIT.ESCALATED, artifacts: { dir: directory } };
    }

    const environments = await workspace.loadEnvironments().catch(() => ({ version: 1, environments: {} }));
    environments.environments = { ...(environments.environments ?? {}), [identity.environment]: { type: "web", baseUrl: parsed.origin } };
    await workspace.saveEnvironments(environments);
    const executionVariables = {
      ...(variables ?? {}),
      ...(username && variables?.QA_USERNAME === undefined ? { QA_USERNAME: username } : {}),
      ...(password && variables?.QA_PASSWORD === undefined ? { QA_PASSWORD: password } : {}),
      ...(username && variables?.QA_CUSTOMER_USERNAME === undefined ? { QA_CUSTOMER_USERNAME: username } : {}),
      ...(password && variables?.QA_CUSTOMER_PASSWORD === undefined ? { QA_CUSTOMER_PASSWORD: password } : {}),
    };

    if (history.kind !== "exact") {
      const generateStarted = performance.now();
      await say("generate", "stage_started", { message: `${plan.flows.length} flows` });
      generation = await generate({ workspace, plan, siteMap, origin: parsed.origin, environment: identity.environment, idPrefix: identity.specPrefix, fetchImpl, executor, outDir: path.join(directory, "generated"), emit: say, now });
      await say("generate", "stage_completed", { message: `${generation.validated}/${generation.specs} validated`, data: { durationMs: durationSince(generateStarted), replayStates: generation.replayStates } });
    }

    const specIds = generation.artifacts ?? [];
    await saveHistoryManifest({
      directory,
      request,
      orchestrationId,
      artifacts: { siteMap: "site-map.json", plan: "test-plan.json", gaps: "gaps.json", specIds, generation: generationSummary(generation, specIds) },
      now,
    });

    if (generation.specs === 0 || generation.validated === 0) {
      const report = buildReport({ plan, gapsHistory, generation, runs, heals, decisions, prd: prdParsed, startedAt, finishedAt: timestamp(now), orchestrationId, target: parsed.origin });
      await writeReport({ outDir: directory, report, emit: say });
      return { report, history, exitCode: EXIT.UNVALIDATED, artifacts: { dir: directory } };
    }

    const flowForSpec = generation.flowMap ?? {};
    const allSpecs = new Map((await workspace.listSpecs()).map((spec) => [spec.id, spec]));
    const specs = specIds.map((id) => allSpecs.get(id)).filter(Boolean);
    const replayStates = history.kind === "exact" ? Object.fromEntries(history.replay.map((entry) => [entry.specId, entry.state])) : generation.replayStates ?? {};
    const schedule = executionConcurrencyFor({ requested: executionConcurrency, specs, replayStates, executor, executorFactory });
    const { allTrusted, isolatedExecutors, concurrency } = schedule;
    await say("run", "stage_started", { message: `Executing ${specs.length} spec(s) with concurrency ${Math.min(concurrency, specs.length || 1)}`, data: { requestedConcurrency: executionConcurrency, effectiveConcurrency: concurrency, isolatedExecutors, allTrusted } });
    const runStarted = performance.now();
    const rows = await runWithResourceLocks(specs, {
      concurrency,
      resource: runResource,
      worker: async (spec) => {
        const flowId = flowForSpec[spec.id] ?? spec.id;
        const specStarted = performance.now();
        try {
          const result = await executeWithReplay({ workspace, specId: spec.id, environmentId: spec.environment, executor, executorFactory, variables: executionVariables, fetchImpl, browserLauncher, selectResult: false, onEvent: async (event) => say("run", event.type, { level: "debug", message: `${spec.id}: ${event.message ?? event.type}` }) });
          const row = runRow({ spec, result, flowId, durationMs: durationSince(specStarted), reused: history.kind === "exact" });
          await say("run", "spec_completed", { message: `${spec.id}: ${result.classification}`, data: { specId: spec.id, mode: result.execution?.mode ?? "native", agentCalls: result.execution?.agentCalls ?? 0, durationMs: row.durationMs } });
          return { row, heals: (result.steps ?? []).flatMap((step) => step.healing ? [{ specId: spec.id, stepIndex: step.index, promoted: step.healing.outcome === "healed", succeeded: step.healing.outcome === "healed" }] : []) };
        } catch (error) {
          return { row: { flowId, specId: spec.id, status: "blocked", classification: "environment", confidence: 0.6, durationMs: durationSince(specStarted), specFile: history.kind === "exact" ? `.qa/specs/${spec.id}.yaml` : `generated/${spec.id}.spec.js`, screenshots: [], heals: [], blockedReason: error instanceof Error ? error.message : String(error) }, heals: [] };
        }
      },
    });
    for (const entry of rows) {
      runs.push(entry.row);
      heals.push(...entry.heals);
    }
    const selectedRun = runs.findLast((run) => run.runId);
    if (selectedRun) await workspace.selectResult(selectedRun.runId);
    await say("run", "stage_completed", { message: `${runs.length} spec(s) completed`, data: { durationMs: durationSince(runStarted), concurrency: Math.min(concurrency, specs.length || 1) } });

    const reportStarted = performance.now();
    const report = buildReport({ plan, gapsHistory, generation, runs, heals, decisions, prd: prdParsed, startedAt, finishedAt: timestamp(now), orchestrationId, target: parsed.origin });
    await writeReport({ outDir: directory, report, emit: say });
    await writeFile(path.join(directory, "report.yaml"), stringifyYaml({ verdict: report.summary.verdict, exitCode: report.summary.exitCode }));
    await say("report", "stage_completed", { message: report.summary.verdict, data: { durationMs: durationSince(reportStarted), history: history.kind } });
    return { report, history, exitCode: report.summary.exitCode, artifacts: { dir: directory } };
  } catch (error) {
    if (error instanceof QaError && error.code === "ORCHESTRATION_REMOTE_BLOCKED") throw error;
    if (error instanceof QaError && ["ORCHESTRATION_TARGET_UNREACHABLE", "ORCHESTRATION_AUTH_FAILED"].includes(error.code)) return { report: null, history, exitCode: EXIT.UNREACHABLE, error };
    if (error instanceof QaError) return { report: null, history, exitCode: EXIT.INTERNAL, error };
    throw error;
  } finally {
    await tracer.close();
  }
}

function withGaps(gaps) {
  return (gaps.checklist ?? []).map((entry) => ({ ...entry, gaps: (gaps.gaps ?? []).filter((gap) => gap.ruleId === entry.ruleId) }));
}
