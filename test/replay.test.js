import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import {
  createNativeWebExecutor,
  createReplayManifest,
  executeWithReplay,
  QaError,
  QaWorkspace,
  renderReplayFromBindings,
  renderRecordedReplay,
  replayHash,
  replayPromotionSafe,
  replaySource,
  replayStatus,
  validateReplayCandidate,
  validateReplayScriptSource,
  runReplayAttempt,
} from "../src/index.js";

async function workspaceFixture(t, { intent = "Open the home page", expectation = "Home is visible" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new QaWorkspace(root);
  await workspace.ensureDirectories();
  await workspace.saveEnvironments({ version: 1, environments: { local: { type: "web", baseUrl: "http://127.0.0.1:43210" } } });
  const spec = { version: 1, id: "home", title: "Home", environment: "local", steps: [{ intent, expect: [expectation] }] };
  await workspace.saveSpec(spec);
  return { workspace, spec, root };
}

function fakeExpect() {
  const matchers = {
    toBeVisible: async () => {}, toBeHidden: async () => {}, toHaveCount: async () => {},
    toContainText: async () => {}, toHaveValue: async () => {}, toHaveURL: async () => {},
  };
  return () => matchers;
}

function fakeBrowserLauncher({ missing = false, clickFails = false, logError = false, logNetwork = false } = {}) {
  let launches = 0;
  const locator = {
    count: async () => missing ? 0 : 1,
    click: async () => { if (clickFails) throw new Error("click failed"); },
    fill: async () => {}, press: async () => {}, check: async () => {}, selectOption: async () => {},
  };
  const page = {
    goto: async () => {},
    getByRole: () => locator, getByLabel: () => locator, getByText: () => locator,
    getByTestId: () => locator, locator: () => locator,
    on(event, callback) {
      if (logError && event === "console") callback({ type: () => "error", text: () => "browser error" });
      if (logNetwork && event === "requestfailed") callback({ method: () => "GET", url: () => "http://bad.test", failure: () => ({ errorText: "reset" }) });
    },
  };
  const launcher = async () => {
    launches += 1;
    return {
      newContext: async () => ({ newPage: async () => page, close: async () => {} }),
      close: async () => {},
    };
  };
  launcher.launches = () => launches;
  return launcher;
}

const reachable = async () => ({ status: 200 });

async function saveCandidate(workspace, spec, state = "candidate") {
  const replay = renderReplayFromBindings({
    spec,
    bindings: [{ page: "/", action: "click", candidates: [{ strategy: "role", value: ["button", { name: "Open" }] }], expectations: [{ prose: spec.steps[0].expect[0], predicate: { kind: "text", value: "Home" } }] }],
  });
  const source = await replaySource(workspace, spec.id, spec.environment);
  const manifest = createReplayManifest({ specId: spec.id, environment: spec.environment, sourceHash: source.sourceHash, script: replay.script, coverage: replay.coverage, state });
  if (state === "trusted") manifest.validation = { required: 3, passed: 3 };
  await workspace.saveReplayArtifacts(spec.id, replay.script, manifest);
  return { replay, manifest };
}

test("replay hashes canonical documents and rejects unsafe or assertion-free scripts", () => {
  assert.equal(replayHash({ b: 2, a: 1 }), replayHash({ a: 1, b: 2 }));
  const valid = "export default async function replay({ checkpoint, expect }) { await checkpoint(1, 0, async () => { await expect('x').toBeVisible(); }); }\n";
  assert.equal(validateReplayScriptSource(valid), valid);
  assert.throws(() => validateReplayScriptSource("export const x = 1"), (error) => error instanceof QaError && error.code === "INVALID_REPLAY_SCRIPT");
  assert.throws(() => validateReplayScriptSource(valid.replace("await expect('x').toBeVisible();", "")), (error) => error.code === "INCOMPLETE_REPLAY_COVERAGE");
  for (const unsafe of ["import('x')", "require('x')", "process.env.X", "waitForTimeout(2)", ".nth(1)", "force: true", "test.skip()", "page.evaluate(() => 1)", "node:fs"]) {
    assert.throws(() => validateReplayScriptSource(valid.replace("await expect('x').toBeVisible();", `${unsafe}; await expect('x').toBeVisible();`)), (error) => error.code === "UNSAFE_REPLAY_SCRIPT");
  }
});

test("replay status detects missing, trusted, edited, and stale artifacts", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  assert.equal((await replayStatus(workspace, spec.id)).state, "missing");
  await saveCandidate(workspace, spec, "trusted");
  assert.equal((await replayStatus(workspace, spec.id)).state, "trusted");
  await writeFile(workspace.replayScriptPath(spec.id), `${await workspace.readReplayScript(spec.id)}// hand edit\n`);
  assert.equal((await replayStatus(workspace, spec.id)).state, "edited");
  await saveCandidate(workspace, spec, "trusted");
  await workspace.saveSpec({ ...spec, title: "Changed" });
  assert.equal((await replayStatus(workspace, spec.id)).state, "stale");
  await assert.rejects(validateReplayCandidate({ workspace, specId: spec.id }), (error) => error.code === "STALE_REPLAY");
  await assert.rejects(replaySource(workspace, spec.id, "unknown"), (error) => error.code === "UNKNOWN_ENVIRONMENT");
});

test("candidate validation requires three isolated passes and rejects the first failure", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  await saveCandidate(workspace, spec);
  const launcher = fakeBrowserLauncher();
  const validated = await validateReplayCandidate({ workspace, specId: spec.id, browserLauncher: launcher, expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(validated.trusted, true);
  assert.equal(validated.attempts.length, 3);
  assert.equal(launcher.launches(), 3);
  assert.equal((await workspace.loadReplayManifest(spec.id)).state, "trusted");

  await saveCandidate(workspace, spec);
  const rejected = await validateReplayCandidate({ workspace, specId: spec.id, browserLauncher: fakeBrowserLauncher({ missing: true }), expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(rejected.trusted, false);
  assert.equal(rejected.attempts.length, 1);
  assert.equal(rejected.manifest.state, "rejected");
});

test("a trusted replay passes without invoking the native agent and records browser logs", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  await saveCandidate(workspace, spec, "trusted");
  let agentCalls = 0;
  const executor = createNativeWebExecutor({
    act: async () => { agentCalls += 1; return {}; },
    observe: async () => ({ status: "passed" }),
    screenshot: async () => Buffer.from("image"),
  });
  const result = await executeWithReplay({ workspace, specId: spec.id, executor, browserLauncher: fakeBrowserLauncher({ logError: true }), expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(result.classification, "passed");
  assert.equal(result.execution.mode, "playwright");
  assert.equal(result.execution.agentCalls, 0);
  assert.equal(agentCalls, 0);
  assert.deepEqual(result.evidence.consoleErrors, ["browser error"]);
  assert.deepEqual(result.evidence.screenshots, []);
  assert.equal((await workspace.readLastTest()).lastRunId, result.runId);
});

test("a replay failure falls back once and keeps the agent verdict in one result", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  await saveCandidate(workspace, spec, "trusted");
  let acts = 0;
  const executor = createNativeWebExecutor({
    act: async () => { acts += 1; return { selectedTarget: { summary: "Home" } }; },
    observe: async () => ({ status: "passed", observation: "Home is visible" }),
    screenshot: async () => Buffer.from("image"),
  });
  const result = await executeWithReplay({ workspace, specId: spec.id, executor, browserLauncher: fakeBrowserLauncher({ missing: true }), expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(result.classification, "passed");
  assert.equal(result.execution.mode, "agent_fallback");
  assert.equal(result.execution.agentCalls, 1);
  assert.equal(acts, 1);
  assert.deepEqual(result.execution.attempts.map((attempt) => attempt.status), ["failed", "passed"]);
  assert.equal((await workspace.loadReplayManifest(spec.id)).state, "rejected");
  assert.equal((await workspace.readLastTest()).lastRunId, result.runId);
});

test("an executor factory takes precedence over a shared fallback executor", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  let sharedCalls = 0;
  let factoryCalls = 0;
  const shared = createNativeWebExecutor({
    act: async () => { sharedCalls += 1; throw new Error("shared executor must not run"); },
    observe: async () => ({ status: "passed" }),
    screenshot: async () => Buffer.from("image"),
  });
  const isolated = createNativeWebExecutor({
    act: async () => ({ selectedTarget: { summary: "Home" } }),
    observe: async () => ({ status: "passed", observation: "Home is visible" }),
    screenshot: async () => Buffer.from("image"),
  });
  const result = await executeWithReplay({
    workspace,
    specId: spec.id,
    executor: shared,
    executorFactory: async () => { factoryCalls += 1; return isolated; },
    fetchImpl: reachable,
  });
  assert.equal(result.classification, "passed");
  assert.equal(factoryCalls, 1);
  assert.equal(sharedCalls, 0);
});

test("a successful recorded agent run promotes a replay and the next run is agent-free", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  let acts = 0;
  const executor = createNativeWebExecutor({
    act: async () => {
      acts += 1;
      return { selectedTarget: { summary: "Open", role: "button", name: "Open" }, replay: { action: { kind: "click", locator: { strategy: "role", value: ["button", { name: "Open" }] } } } };
    },
    observe: async () => ({ status: "passed", observation: "Home", replay: { assertion: { kind: "visible", locator: { strategy: "text", value: "Home" } } } }),
    screenshot: async () => Buffer.from("image"),
  });
  const options = { workspace, specId: spec.id, executor, browserLauncher: fakeBrowserLauncher(), expectImpl: fakeExpect(), fetchImpl: reachable };
  const first = await executeWithReplay(options);
  assert.equal(first.execution.mode, "agent");
  assert.equal(first.execution.script.state, "trusted");
  assert.equal(first.execution.script.validationRuns, 3);
  const second = await executeWithReplay(options);
  assert.equal(second.execution.mode, "playwright");
  assert.equal(second.execution.agentCalls, 0);
  assert.equal(acts, 1);
});

test("hand edits are revalidated and destructive scripts need idempotent cleanup", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  await saveCandidate(workspace, spec, "trusted");
  const original = await readFile(workspace.replayScriptPath(spec.id), "utf8");
  await writeFile(workspace.replayScriptPath(spec.id), `${original}// reviewed edit\n`);
  const result = await executeWithReplay({ workspace, specId: spec.id, browserLauncher: fakeBrowserLauncher(), expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(result.execution.mode, "playwright");
  assert.equal(result.execution.attempts.length, 3);
  assert.equal((await workspace.loadReplayManifest(spec.id)).state, "trusted");
  assert.equal(replayPromotionSafe(spec, []), true);
  const destructive = { ...spec, steps: [{ intent: "Place order", expect: ["Done"] }] };
  assert.equal(replayPromotionSafe(destructive, []), false);
  destructive.fixtures = { after: ["reset"] };
  assert.equal(replayPromotionSafe(destructive, [{ id: "reset", idempotent: true }]), true);
  await workspace.saveFixture({ version: 1, id: "reset", title: "Reset", steps: [{ intent: "Reset state" }], expect: ["State is reset"], idempotent: true });
  await workspace.saveSpec({ ...spec, fixtures: { before: ["reset"] } });
  assert.deepEqual((await replaySource(workspace, spec.id)).fixtures.map((fixture) => fixture.id), ["reset"]);
});

test("binding and recorded renderers cover supported deterministic actions and assertions", () => {
  const spec = { steps: [
    { expect: ["text", "absent", "url", "visible", "gone", "count", "unknown"] },
    { expect: [] },
  ] };
  const rendered = renderReplayFromBindings({
    spec,
    auth: { loginPath: "/login", userField: "email", passwordField: "password", submitLabel: "Sign in" },
    bindings: [
      {
        page: "/form",
        action: "submit",
        inputs: [{ value: "${VALUE}", candidates: [{ strategy: "label", value: "Name" }, null, { strategy: "bogus", value: "x" }] }],
        candidates: [{ strategy: "testid", value: "submit" }],
        expectations: [
          { predicate: { kind: "text", value: "Ready" } },
          { predicate: { kind: "absent_text", value: "Error" } },
          { predicate: { kind: "url_contains", value: "/done" } },
          { predicate: { kind: "visible", selector: "#ok" } },
          { predicate: { kind: "absent", selector: ".gone" } },
          { predicate: { kind: "count", selector: "li", count: 2 } },
          { predicate: { kind: "invented" } },
        ],
      },
      { page: "/done", action: "observe", expectations: [] },
    ],
  });
  assert.equal(rendered.coverage.deterministic, 6);
  assert.equal(rendered.coverage.complete, false);
  assert.match(rendered.script, /QA_USERNAME/);
  assert.match(rendered.script, /toHaveURL/);
  assert.match(rendered.script, /toHaveCount\(2\)/);

  const records = [
    { type: "action", replay: { kind: "goto", path: "/" } },
    { type: "action", replay: { kind: "fill", locator: { strategy: "label", value: "Name" }, valueRef: "${NAME}" } },
    { type: "action", replay: { kind: "press", locator: { strategy: "label", value: "Name" }, key: "Enter" } },
    { type: "action", replay: { kind: "check", locator: { strategy: "label", value: "Agree" } } },
    { type: "action", replay: { kind: "select", locator: { strategy: "label", value: "Country" }, value: "IN" } },
    { type: "action", replay: { kind: "unknown" } },
    { type: "action", replay: { kind: "unknown", locator: { strategy: "text", value: "X" } } },
    { type: "assertion", stepIndex: 1, expectationIndex: 0, replay: { kind: "hidden", locator: { strategy: "text", value: "Busy" } } },
    { type: "assertion", stepIndex: 1, expectationIndex: 1, replay: { kind: "text", locator: { strategy: "css", value: "main" }, value: "Ready" } },
    { type: "assertion", stepIndex: 1, expectationIndex: 2, replay: { kind: "value", locator: { strategy: "label", value: "Name" }, value: "A" } },
    { type: "assertion", stepIndex: 1, expectationIndex: 3, replay: { kind: "count", locator: { strategy: "css", value: "li" }, count: 2 } },
    { type: "assertion", stepIndex: 1, expectationIndex: 4, replay: { kind: "url", value: "/done" } },
    { type: "assertion", stepIndex: 1, expectationIndex: 5, replay: { kind: "unknown", locator: { strategy: "text", value: "X" } } },
  ];
  const recorded = renderRecordedReplay(records, { steps: [{ expect: ["a", "b", "c", "d", "e", "f"] }] });
  assert.equal(recorded.coverage.deterministic, 5);
  assert.match(recorded.script, /selectOption/);
  assert.match(recorded.script, /toBeHidden/);
  assert.match(recorded.script, /toHaveValue/);
});

test("runtime rejects missing inputs, duplicate checks, incomplete coverage, and unsupported locators", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  const source = await replaySource(workspace, spec.id, spec.environment);
  const cases = [
    ["await (await target([{ strategy: 'label', value: 'Name' }])).fill(value('${SECRET}')); await checkpoint(1, 0, async () => { await expect('x').toBeVisible(); });", "Missing replay input"],
    ["await checkpoint(1, 0, async () => { await expect('x').toBeVisible(); }); await checkpoint(1, 0, async () => { await expect('x').toBeVisible(); });", "more than once"],
    ["await (await target([{ strategy: 'bogus', value: 'x' }])).click(); await checkpoint(1, 0, async () => { await expect('x').toBeVisible(); });", "Unsupported locator strategy"],
  ];
  for (const [body, reason] of cases) {
    const script = `export default async function replay({ expect, checkpoint, target, value }) { ${body} }\n`;
    const manifest = createReplayManifest({ specId: spec.id, environment: spec.environment, sourceHash: source.sourceHash, script, coverage: { deterministic: 1, total: 1, complete: true }, state: "trusted" });
    manifest.validation.passed = 3;
    await workspace.saveReplayArtifacts(spec.id, script, manifest);
    const attempt = await runReplayAttempt({ workspace, specId: spec.id, browserLauncher: fakeBrowserLauncher(), expectImpl: fakeExpect(), fetchImpl: reachable });
    assert.equal(attempt.status, "failed");
    assert.match(attempt.reason, new RegExp(reason));
  }
  const script = "export default async function replay({ expect, checkpoint }) { await checkpoint(1, 0, async () => { await expect('x').toBeVisible(); }); }\n";
  const incomplete = createReplayManifest({ specId: spec.id, environment: spec.environment, sourceHash: source.sourceHash, script, coverage: { deterministic: 1, total: 2, complete: false }, state: "trusted" });
  await workspace.saveReplayArtifacts(spec.id, script, incomplete);
  const attempt = await runReplayAttempt({ workspace, specId: spec.id, browserLauncher: fakeBrowserLauncher(), expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.match(attempt.reason, /checked 1\/2/);

  const valueScript = "export default async function replay({ expect, checkpoint, target, value }) { await (await target([{ strategy: 'testid', value: 'one' }])).fill(value('${SECRET}')); await (await target([{ strategy: 'css', value: '#two' }])).click(); await checkpoint(1, 0, async () => { await expect('x').toBeVisible(); }); }\n";
  const valueManifest = createReplayManifest({ specId: spec.id, environment: spec.environment, sourceHash: source.sourceHash, script: valueScript, coverage: { deterministic: 1, total: 1, complete: true }, state: "trusted" });
  await workspace.saveReplayArtifacts(spec.id, valueScript, valueManifest);
  const valueAttempt = await runReplayAttempt({ workspace, specId: spec.id, variables: { SECRET: "redacted" }, browserLauncher: fakeBrowserLauncher({ logNetwork: true }), expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(valueAttempt.status, "passed");
  assert.deepEqual(valueAttempt.networkErrors, ["GET http://bad.test: reset"]);
});

test("browser channel fallback and hybrid execution remain explicit", async (t) => {
  const { workspace, spec } = await workspaceFixture(t);
  await saveCandidate(workspace, spec, "trusted");
  const fallbackLauncher = fakeBrowserLauncher();
  const channelLauncher = async (channel) => {
    if (channel === "chrome") throw new Error("chrome unavailable");
    return fallbackLauncher();
  };
  const attempt = await runReplayAttempt({ workspace, specId: spec.id, browserLauncher: channelLauncher, expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(attempt.browserChannel, "msedge");

  const mixed = { ...spec, steps: [{ ...spec.steps[0], channel: "chat" }] };
  await workspace.saveSpec(mixed);
  await saveCandidate(workspace, mixed, "trusted");
  let calls = 0;
  const executor = createNativeWebExecutor({
    act: async () => { calls += 1; return {}; },
    observe: async () => ({ status: "passed" }),
    screenshot: async () => Buffer.from("image"),
  });
  const result = await executeWithReplay({ workspace, specId: mixed.id, executor, browserLauncher: fakeBrowserLauncher(), expectImpl: fakeExpect(), fetchImpl: reachable });
  assert.equal(result.execution.mode, "hybrid");
  assert.equal(calls, 1);
});

test("CLI exposes replay status and validation without changing run commands", async (t) => {
  const { workspace, spec, root } = await workspaceFixture(t);
  const output = [];
  assert.equal(await runCli(["replay", "status", spec.id, "--root", root], { output: (line) => output.push(String(line)) }), 0);
  assert.match(output.join("\n"), /"state": "missing"/);
  await saveCandidate(workspace, spec);
  output.length = 0;
  assert.equal(await runCli(["replay", "validate", spec.id, "--root", root], { output: (line) => output.push(String(line)), error: (line) => output.push(String(line)), browserLauncher: fakeBrowserLauncher(), expectImpl: fakeExpect(), fetchImpl: reachable }), 0);
  assert.match(output.join("\n"), /"trusted": true/);
  assert.equal(await runCli(["replay", "unknown", spec.id, "--root", root], { output: () => {}, error: (line) => output.push(String(line)) }), 1);
  assert.equal(await runCli(["replay", "status", "--root", root], { output: () => {}, error: (line) => output.push(String(line)) }), 1);
});
