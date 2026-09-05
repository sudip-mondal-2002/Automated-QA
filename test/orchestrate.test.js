import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildChain, resolveWithChain, triage } from "../src/locator-chain.js";
import { bindLocators, generate, planToSpecs, renderPlaywrightSpec, renderResolveHelper, validateSelectors } from "../src/generator.js";
import { buildReport, computeUntestedRisk, diffPrd, renderReportMarkdown } from "../src/reporter.js";
import { assertTargetAllowed, EXIT, orchestrate } from "../src/orchestrator.js";
import { temporaryWorkspace } from "../test-support/helpers.js";
import { createDemoApplication } from "../demo-app/server.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { QaError, replayStatus } from "../src/index.js";

test("locator chain orders, dedupes and resolves first hit", async () => {
  const chain = buildChain([{ strategy: "css", value: "a" }, { strategy: "testid", value: "x" }, { strategy: "testid", value: "x" }]);
  assert.deepEqual(chain.map((c) => c.strategy), ["testid", "css"]);
  const hit = await resolveWithChain({ candidates: [{ strategy: "role", value: "b" }, { strategy: "text", value: "t" }], probe: async (c) => c.strategy === "text" });
  assert.equal(hit.resolved.strategy, "text");
  assert.equal(hit.attempts.length, 2);
  const exhausted = await resolveWithChain({ candidates: [{ strategy: "css", value: "z" }], probe: async () => false });
  assert.equal(exhausted.resolved, null);
});

test("triage separates broken locators, defects, flaky and environment", () => {
  assert.equal(triage({ failure: { message: "x" }, chainResult: { resolved: { strategy: "role" }, attempts: [{ strategy: "testid" }, { strategy: "role" }] } }).classification, "broken_locator");
  assert.equal(triage({ failure: { message: "timeout" }, chainResult: { resolved: null, attempts: [{ strategy: "css" }] }, httpStatus: 500 }).classification, "app_defect");
  assert.equal(triage({ failure: { code: "ENVIRONMENT_UNREACHABLE" }, chainResult: { resolved: null, attempts: [{ strategy: "css" }] }, httpStatus: 0 }).classification, "environment");
  assert.equal(triage({ failure: { code: "EXPECTATION_MUTATED" }, chainResult: { resolved: { strategy: "text" }, attempts: [{}] } }).classification, "app_defect");
  assert.equal(triage({ chainResult: { resolved: { strategy: "text" }, attempts: [{ strategy: "text" }] }, priorAttempts: 1 }).classification, "flaky");
  assert.equal(triage({}).classification, "environment");
});

test("generator emits validated Playwright specs from recorded fixtures", async (t) => {
  const plan = JSON.parse(await readFile(new URL("../test-support/fixtures/demo-test-plan.json", import.meta.url), "utf8"));
  const siteMap = JSON.parse(await readFile(new URL("../test-support/fixtures/demo-site-map.json", import.meta.url), "utf8"));
  const specs = planToSpecs({ plan });
  assert.ok(specs.length > 0);
  assert.ok(specs[0].id);
  const { workspace } = await temporaryWorkspace(t);
  const out = await generate({ workspace, plan: { ...plan, flows: plan.flows.slice(0, 2) }, siteMap, origin: siteMap.origin, fetchImpl: async () => ({ text: async () => "<button>Sign in</button>" }) });
  assert.equal(out.specs, 2);
  assert.ok(out.validated >= 1);
  assert.ok(renderResolveHelper().includes("export async function resolve"));
  const rendered = renderPlaywrightSpec({ spec: { id: "x", title: "X", steps: [{ intent: "Go", expect: ["Hi"] }] }, flow: {}, sidecar: { bindings: [{ page: "/", candidates: [{ strategy: "text", value: "Go" }] }] }, validation: { validated: false, bindings: [{ page: "/", candidates: [{ strategy: "text", value: "Go" }] }] }, origin: "http://127.0.0.1:3000" });
  assert.match(rendered, /test\.fixme/);
  const sidecar = bindLocators({ spec: { ...specs[0], _targetRefs: [null] }, flow: plan.flows[0], siteMap });
  assert.ok(sidecar.bindings.length > 0);
  const validation = await validateSelectors({ sidecar, origin: siteMap.origin, fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(validation.validated, false);

  const trustedId = out.artifacts[0];
  const before = await replayStatus(workspace, trustedId);
  await workspace.saveReplayManifest(trustedId, { ...before.manifest, state: "trusted", validation: { required: 3, passed: 3 } });
  await generate({ workspace, plan: { ...plan, flows: plan.flows.slice(0, 2) }, siteMap, origin: siteMap.origin, fetchImpl: async () => ({ text: async () => "<button>Sign in</button>" }) });
  assert.equal((await replayStatus(workspace, trustedId)).state, "trusted", "idempotent generation must preserve source-matched trust");
});

test("reporter builds defects-first report with PRD gaps", () => {
  const plan = { id: "p", generatedAt: new Date().toISOString(), flows: [{ id: "a", title: "A", category: "happy", priority: "high" }] };
  const report = buildReport({ plan, generation: { specs: 1, validated: 1 }, runs: [{ flowId: "a", status: "failed", classification: "app_defect" }], decisions: [{ stage: "gate", decision: "pass", reason: "ok" }], target: "http://x" });
  assert.equal(report.summary.verdict, "defects_found");
  assert.equal(report.summary.exitCode, 10);
  assert.match(renderReportMarkdown(report), /PRD gap analysis/);
  assert.equal(diffPrd({}).coveragePct, 1);
  assert.deepEqual(computeUntestedRisk({ siteMap: { pages: [{ path: "/z" }] }, plan, gaps: {} }), [{ area: "/z", reason: "no flow covers this page", risk: "medium", impact: "unverified surface" }]);
});

test("orchestrator guards targets and remote policy", () => {
  assert.throws(() => assertTargetAllowed("not-a-url"), (e) => e instanceof QaError);
  assert.throws(() => assertTargetAllowed("https://example.com", {}), (e) => e.code === "ORCHESTRATION_REMOTE_BLOCKED");
  assert.equal(EXIT.OK, 0);
});

test("orchestrate runs demo app end to end with trace and report", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication();
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  const { report, exitCode, artifacts } = await orchestrate({
    url: baseUrl,
    root: workspace.repositoryRoot,
    maxPages: 5,
    maxDepth: 1,
    executor: demoNativeExecutor(),
    variables: { QA_CUSTOMER_USERNAME: "u", QA_CUSTOMER_PASSWORD: "p" },
  });
  assert.ok(report.orchestrationId);
  assert.ok([0, 10, 11].includes(exitCode));
  assert.ok(artifacts.dir.includes("orchestrations"));
  const trace = await readFile(`${artifacts.dir}/trace.jsonl`, "utf8");
  assert.match(trace, /stage_started|decision/);
  const md = await readFile(`${artifacts.dir}/report.md`, "utf8");
  assert.match(md, /Test Quality Report/);
});

test("orchestrate rejects remote without flag and unreachable targets", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await assert.rejects(() => orchestrate({ url: "https://example.com", root: workspace.repositoryRoot }), /allow-remote/);
  const unreachable = await orchestrate({ url: "http://127.0.0.1:1", root: workspace.repositoryRoot, fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(unreachable.exitCode, 20);
});
