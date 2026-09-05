import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDemoApplication } from "../demo-app/server.js";
import {
  createHistoryRequest,
  createReplayManifest,
  executionConcurrencyFor,
  objectiveTerms,
  orchestrate,
  replaySource,
  resolveApplicationRevision,
  resolveHistory,
  runWithResourceLocks,
  similarityScore,
} from "../src/index.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { temporaryWorkspace } from "../test-support/helpers.js";

const execFileAsync = promisify(execFile);

test("history fingerprints semantic objectives and invalidate changed dependencies", () => {
  const base = { target: "http://127.0.0.1:3000/path", prompt: "Verify checkout authentication", appRevision: "abc" };
  const reordered = createHistoryRequest({ ...base, prompt: "Authentication: verify checkout" });
  const original = createHistoryRequest(base);
  assert.equal(original.fingerprint, reordered.fingerprint);
  assert.notEqual(original.fingerprint, createHistoryRequest({ ...base, appRevision: "def" }).fingerprint);
  assert.notEqual(original.fingerprint, createHistoryRequest({ ...base, authScope: "authenticated" }).fingerprint);
  assert.notEqual(original.fingerprint, createHistoryRequest({ ...base, prd: { requirements: [{ id: "R1", text: "Changed" }] } }).fingerprint);
  assert.notEqual(original.fingerprint, createHistoryRequest({ ...base, crawlerVersion: "next" }).fingerprint);
  assert.deepEqual(objectiveTerms("Checkout with ultra-secret", { sensitiveValues: ["ultra-secret"] }), ["checkout"]);
  assert.equal(similarityScore(["checkout", "cart"], ["cart", "checkout", "catalog"]), 0.8);
  assert.ok(similarityScore(["checkout"], ["checkout", "catalog", "account", "orders", "admin"]) < 0.35);
});

test("application revision hashes staged, unstaged, and untracked source content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-revision-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const git = (...args) => execFileAsync("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.name", "QA Test");
  await git("config", "user.email", "qa@example.invalid");
  await writeFile(path.join(root, "app.js"), "export const value = 1;\n");
  await git("add", "app.js");
  await git("commit", "-qm", "base");

  const base = await resolveApplicationRevision(root);
  await writeFile(path.join(root, "app.js"), "export const value = 2;\n");
  const unstaged = await resolveApplicationRevision(root);
  await git("add", "app.js");
  const staged = await resolveApplicationRevision(root);
  await writeFile(path.join(root, "new.js"), "export const newValue = 1;\n");
  const untracked = await resolveApplicationRevision(root);
  await writeFile(path.join(root, "new.js"), "export const newValue = 2;\n");
  const editedUntracked = await resolveApplicationRevision(root);

  assert.equal(new Set([base, unstaged, staged, untracked, editedUntracked]).size, 5);
  const nonGitOne = await resolveApplicationRevision(path.join(root, "missing"));
  const nonGitTwo = await resolveApplicationRevision(path.join(root, "missing"));
  assert.match(nonGitOne, /^unresolved:/);
  assert.notEqual(nonGitOne, nonGitTwo);
});

test("semantic history surfaces a source-matched trusted replay without treating it as exact", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await workspace.saveEnvironments({ version: 1, environments: { local: { type: "web", baseUrl: "http://127.0.0.1:3210" } } });
  const spec = { version: 1, id: "customer-checkout", title: "Customer checkout", environment: "local", steps: [{ intent: "Open cart and checkout", expect: ["Order confirmation is visible"] }] };
  await workspace.saveSpec(spec);
  const script = "export default async function replay({ checkpoint, expect }) { await checkpoint(1, 0, async () => { await expect('confirmation').toBeVisible(); }); }\n";
  const source = await replaySource(workspace, spec.id);
  const manifest = createReplayManifest({ specId: spec.id, environment: "local", sourceHash: source.sourceHash, script, coverage: { deterministic: 1, total: 1, complete: true }, state: "trusted" });
  manifest.validation = { required: 3, passed: 3 };
  await workspace.saveReplayArtifacts(spec.id, script, manifest);
  const request = createHistoryRequest({ target: "http://127.0.0.1:3210", prompt: "Verify customer cart checkout confirmation" });
  const history = await resolveHistory({ workspace, request });
  assert.equal(history.kind, "similar");
  assert.equal(history.candidates[0].specId, spec.id);
  assert.equal(history.candidates[0].replayState, "trusted");
});

test("semantic history never recommends a replay from another target origin", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const environments = await workspace.loadEnvironments();
  environments.environments.other = { type: "web", baseUrl: "http://127.0.0.1:9999" };
  await workspace.saveEnvironments(environments);
  const spec = { version: 1, id: "other-checkout", title: "Customer checkout", environment: "other", steps: [{ intent: "Open cart and checkout", expect: ["Order confirmation"] }] };
  await workspace.saveSpec(spec);
  const request = createHistoryRequest({ target: "http://127.0.0.1:3210", prompt: "customer cart checkout confirmation" });
  const history = await resolveHistory({ workspace, request });
  assert.equal(history.kind, "miss");
  assert.deepEqual(history.candidates, []);
});

test("identical orchestration reuses plan/spec history and skips crawl and generation", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication();
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  const fixturePlan = JSON.parse(await readFile(new URL("../test-support/fixtures/demo-test-plan.json", import.meta.url), "utf8"));
  const draft = {
    flows: fixturePlan.flows.map((flow) => ({
      ...flow,
      steps: flow.steps.map(({ targetRef: _targetRef, ...step }) => ({
        ...step,
        expect: step.expect.map((prose) => ({ prose, assert: { kind: "url_contains", value: step.page ?? flow.pages[0] ?? "/" } })),
      })),
    })),
  };
  const options = {
    url: baseUrl,
    root: workspace.repositoryRoot,
    maxPages: 5,
    maxDepth: 1,
    executor: demoNativeExecutor(),
    variables: { QA_CUSTOMER_USERNAME: "u", QA_CUSTOMER_PASSWORD: "p" },
    appRevision: "immutable-demo-v1",
    planner: async () => draft,
    planningConcurrency: 1,
  };
  const cold = await orchestrate({ ...options, historyMode: "off" });
  assert.ok(cold.report, cold.error?.stack ?? cold.error?.message ?? "cold orchestration did not produce a report");
  await readFile(`${cold.artifacts.dir}/request.json`, "utf8");

  const warm = await orchestrate(options);
  assert.equal(warm.history.kind, "exact");
  assert.equal(warm.history.manifest.orchestrationId, cold.report.orchestrationId);
  const trace = await readFile(`${warm.artifacts.dir}/trace.jsonl`, "utf8");
  assert.match(trace, /"event":"history_hit"/);
  assert.doesNotMatch(trace, /"stage":"generate","event":"stage_started"/);
  assert.doesNotMatch(trace, /"event":"crawl_started"/);
  assert.deepEqual(warm.report.scenarios.map((scenario) => scenario.id), cold.report.scenarios.map((scenario) => scenario.id));
});

test("resource locks preserve parallelism only for independent work", async () => {
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const output = await runWithResourceLocks(
    [{ id: "a", key: "shared" }, { id: "b", key: "shared" }, { id: "c", key: "isolated" }],
    {
      concurrency: 2,
      resource: (item) => item.key,
      worker: async (item) => {
        starts.push({ id: item.id, active });
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return item.id;
      },
    },
  );
  assert.equal(maxActive, 2, "one isolated job overlaps while shared jobs serialize");
  assert.ok(starts.find((entry) => entry.id === "b").active <= 1);
  assert.ok(starts.findIndex((entry) => entry.id === "c") < starts.findIndex((entry) => entry.id === "b"), "a lock waiter does not block an independent queued job");
  assert.deepEqual(output, ["a", "b", "c"], "completion timing cannot reorder aggregated results");

  active = 0;
  maxActive = 0;
  await runWithResourceLocks(Array.from({ length: 10 }, (_, index) => ({ id: `job-${index}` })), {
    concurrency: 100,
    resource: (item) => item.id,
    worker: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  });
  assert.equal(maxActive, 8, "programmatic callers cannot bypass the execution bound");
});

test("execution concurrency requires isolated fallback or replay-only work", () => {
  const specs = [{ id: "one" }, { id: "two" }];
  const replayStates = { one: "trusted", two: "trusted" };
  assert.equal(executionConcurrencyFor({ requested: 3, specs, replayStates, executor: {}, executorFactory: async () => {} }).concurrency, 3);
  assert.equal(executionConcurrencyFor({ requested: 3, specs, replayStates }).concurrency, 3);
  assert.equal(executionConcurrencyFor({ requested: 3, specs, replayStates, executor: {} }).concurrency, 1, "a shared native fallback must serialize");
  assert.equal(executionConcurrencyFor({ requested: 3, specs, replayStates: { one: "trusted", two: "missing" } }).concurrency, 1);
  assert.equal(executionConcurrencyFor({ requested: 99, specs, replayStates, executorFactory: async () => {} }).concurrency, 8);
});
