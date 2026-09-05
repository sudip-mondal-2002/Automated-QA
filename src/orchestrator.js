import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { QaError } from "./errors.js";
import { createTracer } from "./trace.js";
import { buildTestPlan, crawl, parsePrd, renderTestPlanMarkdown, replan } from "./planner.js";
import { planWithAgent } from "./planner-agent.js";
import { validateDocument } from "./schema-validator.js";
import { decideVerdict, evaluatePlan, renderGapsMarkdown } from "./coverage.js";
import { generate } from "./generator.js";
import { executeWithReplay } from "./replay.js";
import { buildReport, writeReport } from "./reporter.js";
import { QaWorkspace } from "./storage.js";
import { stringifyYaml } from "./documents.js";

export const EXIT = Object.freeze({ OK: 0, DEFECTS: 10, ESCALATED: 11, UNVALIDATED: 12, UNREACHABLE: 20, USAGE: 30, INTERNAL: 40 });
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

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

export function planStages(state) {
  const order = ["bootstrap", "probe", "plan", "gate", "generate", "run", "heal", "report", "done"];
  const index = order.indexOf(state.stage);
  if (index === -1) return "bootstrap";
  if (state.stage === "gate" && state.verdict === "replan") return "plan";
  return order[Math.min(index + 1, order.length - 1)];
}

export async function orchestrate({
  url,
  username,
  password,
  prompt = "",
  prd,
  prdText,
  outDir,
  root = process.cwd(),
  maxReplans = 2,
  maxPages = 25,
  maxDepth = 3,
  allowRemote = false,
  fetchImpl = globalThis.fetch,
  executor,
  variables = process.env,
  now = () => new Date(),
  emit,
  planner,
  planOnly = false,
  browserLauncher,
} = {}) {
  if (!url) throw new QaError("ORCHESTRATION_TARGET_UNREACHABLE", "--url is required");
  const parsed = assertTargetAllowed(url, { allowRemote });
  const startedAt = (now() instanceof Date ? now() : new Date(now())).toISOString();
  const orchestrationId = `orch_${Date.parse(startedAt)}`;
  const workspace = new QaWorkspace(root);
  await workspace.ensureDirectories();
  const directory = outDir ?? path.join(workspace.qaDirectory, "runs", "orchestrations", orchestrationId);
  await mkdir(directory, { recursive: true });
  // Seed redaction with everything secret this run knows about. The tracer was
  // constructed with no sensitiveValues at all, so nothing was redacted.
  const secrets = [password, username].filter((value) => typeof value === "string" && value.length > 3);
  const tracer = createTracer({
    now,
    sensitiveValues: secrets,
    writeLine: async (line) => { await writeFile(path.join(directory, "trace.jsonl"), line, { flag: "a" }); },
  });
  const say = emit ?? tracer.emit.bind(tracer);

  if (planner) await say("bootstrap", "planner_ready", { message: "Planner sub-agent capability provided by the host" });

  const decisions = [];
  const gapsHistory = [];
  const heals = [];
  const runs = [];

  try {
    await say("probe", "stage_started", { message: `Probing ${parsed.origin}` });
    let probeOk = false;
    try {
      const response = await fetchImpl(parsed.origin, { method: "GET", redirect: "manual" });
      probeOk = response.status < 500;
    } catch {
      probeOk = false;
    }
    if (!probeOk) throw new QaError("ORCHESTRATION_TARGET_UNREACHABLE", `Target unreachable: ${parsed.origin}`);
    await say("probe", "stage_completed", { message: "Target reachable" });

    const credentials = username && password ? { username, password } : undefined;
    await say("plan", "stage_started", { message: "Crawling target" });
    let siteMap = await crawl({ url: parsed.href, credentials, fetchImpl, maxPages, maxDepth, emit: say, now });
    try {
      validateDocument("siteMap", siteMap);
    } catch (error) {
      await say("plan", "site_map_invalid", { level: "warn", message: error instanceof Error ? error.message : String(error) });
    }
    await writeFile(path.join(directory, "site-map.json"), `${JSON.stringify(siteMap, null, 2)}\n`);
    const prdParsed = prdText !== undefined ? parsePrd(prdText) : { requirements: [] };
    let plan = planner
      ? await planWithAgent({ planner, siteMap, prompt, prd: prdParsed, emit: say, now })
      : { ...buildTestPlan({ siteMap, prompt, prd: prdParsed, now }), source: { planner: "deterministic", fellBack: false } };
    let attempt = 1;
    let prevScore;
    let gaps = evaluatePlan({ plan, siteMap, prd: prdParsed, prompt });
    gapsHistory.push(gaps);
    let verdict = decideVerdict({ checklist: withGaps(gaps), attempt, maxReplans, prevScore, score: gaps.score });
    decisions.push({ seq: decisions.length + 1, stage: "gate", decision: verdict, reason: `score ${gaps.score}, attempt ${attempt}/${maxReplans}`, at: new Date().toISOString() });
    await say("gate", "decision", { message: `${verdict} at ${gaps.score}` });

    while (verdict === "replan" && attempt < maxReplans) {
      prevScore = gaps.score;
      plan = replan({ plan, gaps, siteMap, now });
      attempt += 1;
      gaps = evaluatePlan({ plan, siteMap, prd: prdParsed, prompt });
      gapsHistory.push(gaps);
      verdict = decideVerdict({ checklist: withGaps(gaps), attempt, maxReplans, prevScore, score: gaps.score });
      decisions.push({ seq: decisions.length + 1, stage: "gate", decision: verdict, reason: `score ${gaps.score} vs prev ${prevScore}`, at: new Date().toISOString() });
      await say("gate", "replan_triggered", { message: `attempt ${attempt}: ${gaps.score}` });
    }

    try {
      validateDocument("testPlan", plan);
    } catch (error) {
      await say("plan", "plan_invalid", { level: "warn", message: error instanceof Error ? error.message : String(error) });
    }
    await writeFile(path.join(directory, "test-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    await writeFile(path.join(directory, "test-plan.md"), renderTestPlanMarkdown(plan));
    try {
      validateDocument("gaps", gaps);
    } catch (error) {
      await say("gate", "gaps_invalid", { level: "warn", message: error instanceof Error ? error.message : String(error) });
    }
    await writeFile(path.join(directory, "gaps.json"), `${JSON.stringify(gaps, null, 2)}\n`);
    await writeFile(path.join(directory, "gaps.md"), renderGapsMarkdown(gaps));

    if (planOnly) {
      await say("plan", "plan_only", { message: `Stopping after planning: ${plan.flows.length} flows, score ${gaps.score}` });
      const report = buildReport({ plan, gapsHistory, generation: {}, runs: [], heals: [], decisions, prd: prdParsed, startedAt, finishedAt: new Date().toISOString(), orchestrationId, target: parsed.origin });
      await writeReport({ outDir: directory, report, emit: say });
      return { report, plan, gaps, exitCode: EXIT.UNVALIDATED, artifacts: { dir: directory } };
    }

    // point workspace at target
    try {
      const environments = await workspace.loadEnvironments().catch(() => ({ version: 1, environments: {} }));
      environments.environments = { ...(environments.environments ?? {}), local: { type: "web", baseUrl: parsed.origin } };
      await workspace.saveEnvironments(environments);
    } catch {}

    await say("generate", "stage_started", { message: `${plan.flows.length} flows` });
    const generation = await generate({ workspace, plan, siteMap, origin: parsed.origin, fetchImpl, executor, outDir: path.join(directory, "generated"), emit: say, now });
    await say("generate", "stage_completed", { message: `${generation.validated}/${generation.specs} validated` });
    if (generation.specs === 0 || generation.validated === 0) {
      const report = buildReport({ plan, gapsHistory, generation, runs, heals, decisions, prd: prdParsed, startedAt, finishedAt: new Date().toISOString(), orchestrationId, target: parsed.origin });
      await writeReport({ outDir: directory, report, emit: say });
      return { report, exitCode: EXIT.UNVALIDATED, artifacts: { dir: directory } };
    }

    await say("run", "stage_started", { message: "Executing semantic specs" });
    // Execute exactly what this run generated. Listing the shared spec
    // directory and taking the last N picked up the developer's own specs
    // (listSpecs sorts alphabetically) and silently dropped generated ones.
    const flowForSpec = generation.flowMap ?? {};
    const allSpecs = new Map((await workspace.listSpecs()).map((spec) => [spec.id, spec]));
    const specs = (generation.artifacts ?? []).map((id) => allSpecs.get(id)).filter(Boolean);
    for (const spec of specs) {
      const flowId = flowForSpec[spec.id] ?? spec.id;
      try {
        const started = Date.now();
        const result = await executeWithReplay({ workspace, specId: spec.id, environmentId: spec.environment, executor, variables, fetchImpl, browserLauncher });
        const durationMs = Date.now() - started;
        const classification = result.classification;
        const status = classification === "passed" ? "passed" : classification === "healed" ? "healed" : classification === "blocked" ? "blocked" : "failed";
        // A clean run is not a broken locator. Only a run that actually
        // recovered from locator drift earns that label.
        const healedHere = (result.steps ?? []).some((step) => step.healing?.outcome === "healed");
        const triaged = status === "failed"
          ? "app_defect"
          : status === "blocked"
            ? "environment"
            : healedHere ? "broken_locator" : "none";
        runs.push({ flowId, specId: spec.id, status, classification: triaged, confidence: status === "failed" ? 0.7 : status === "blocked" ? 0.95 : 0.9, durationMs, specFile: `generated/${spec.id}.spec.js`, runId: result.runId, runClassification: classification, screenshots: result.evidence?.screenshots ?? [], heals: (result.steps ?? []).flatMap((s) => s.healing ? [{ stepIndex: s.index, from: s.healing.originalFailure, to: s.healing.replacement, promoted: s.healing.outcome === "healed", succeeded: s.healing.outcome === "healed" }] : []), ...(status === "blocked" ? { blockedReason: result.explanation } : {}) });
        for (const step of result.steps ?? []) {
          if (step.healing) heals.push({ specId: spec.id, stepIndex: step.index, promoted: step.healing.outcome === "healed", succeeded: step.healing.outcome === "healed" });
        }
        await say("run", "stage_completed", { message: `${spec.id}: ${result.classification}` });
      } catch (error) {
        runs.push({ flowId, specId: spec.id, status: "blocked", classification: "environment", confidence: 0.6, durationMs: 0, specFile: `generated/${spec.id}.spec.js`, screenshots: [], heals: [], blockedReason: error instanceof Error ? error.message : String(error) });
      }
    }

    const escalated = verdict === "escalate";
    const report = buildReport({ plan, gapsHistory, generation, runs, heals, decisions, prd: prdParsed, startedAt, finishedAt: new Date().toISOString(), orchestrationId, target: parsed.origin });
    await writeReport({ outDir: directory, report, emit: say });
    await writeFile(path.join(directory, "report.yaml"), stringifyYaml({ verdict: report.summary.verdict, exitCode: report.summary.exitCode }));
    const exitCode = report.summary.exitCode !== 0 ? report.summary.exitCode : escalated ? EXIT.ESCALATED : EXIT.OK;
    return { report, exitCode, artifacts: { dir: directory } };
  } catch (error) {
    if (error instanceof QaError && error.code === "ORCHESTRATION_REMOTE_BLOCKED") throw error;
    if (error instanceof QaError && ["ORCHESTRATION_TARGET_UNREACHABLE", "ORCHESTRATION_AUTH_FAILED"].includes(error.code)) {
      return { report: null, exitCode: EXIT.UNREACHABLE, error };
    }
    if (error instanceof QaError) return { report: null, exitCode: EXIT.INTERNAL, error };
    throw error;
  }
}

function withGaps(gaps) {
  return (gaps.checklist ?? []).map((entry) => ({ ...entry, gaps: (gaps.gaps ?? []).filter((gap) => gap.ruleId === entry.ruleId) }));
}
