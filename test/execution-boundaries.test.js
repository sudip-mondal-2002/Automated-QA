import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createNativeWebExecutor, executeRun, QaError } from "../src/index.js";
import { temporaryWorkspace } from "../test-support/helpers.js";

const IMAGE = Buffer.from("image-data");

async function saveSimpleSpec(workspace, overrides = {}) {
  const spec = {
    version: 1,
    id: "simple-journey",
    title: "Simple journey",
    environment: "local",
    steps: [
      { intent: "Use the primary control", expect: ["The first outcome is visible"] },
      { intent: "Continue the journey", expect: ["The final outcome is visible"] },
    ],
    ...overrides,
  };
  await workspace.saveSpec(spec);
  return spec;
}

function executor(driver = {}) {
  return createNativeWebExecutor({
    act: () => ({}),
    observe: () => ({ status: "passed" }),
    screenshot: () => IMAGE,
    ...driver,
  });
}

function runOptions(workspace, runId, nativeExecutor, extra = {}) {
  return {
    workspace,
    specId: "simple-journey",
    runId,
    executor: nativeExecutor,
    fetchImpl: async () => ({ status: 200 }),
    ...extra,
  };
}

test("action and observation failures classify without executing later steps", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveSimpleSpec(workspace);
  const cases = [
    [
      "run_20260830_130000",
      executor({ act: () => { throw "action exploded"; } }),
      "functional_regression",
      /action exploded/,
    ],
    [
      "run_20260830_130001",
      executor({ act: () => { throw new QaError("NATIVE_BLOCKED", "browser needs attention"); } }),
      "blocked",
      /browser needs attention/,
    ],
    [
      "run_20260830_130002",
      executor({
        act: () => ({ status: "failed", observation: "Old target is absent", selectedTarget: { role: "button", name: "Old action" } }),
      }),
      "functional_regression",
      /Old target is absent/,
    ],
    [
      "run_20260830_130003",
      executor({ observe: () => false }),
      "functional_regression",
      /Step 1 failed/,
    ],
    [
      "run_20260830_130004",
      executor({ observe: () => ({ status: "unknown" }) }),
      "functional_regression",
      /invalid observation status/,
    ],
    [
      "run_20260830_130005",
      executor({ observe: () => { throw new QaError("NATIVE_BLOCKED", "observation unavailable"); } }),
      "blocked",
      /observation unavailable/,
    ],
  ];

  for (const [runId, nativeExecutor, classification, explanation] of cases) {
    const result = await executeRun(runOptions(workspace, runId, nativeExecutor));
    assert.equal(result.classification, classification);
    assert.match(result.explanation, explanation);
    assert.equal(result.steps[1].status, "skipped");
  }
  const selected = (await workspace.loadResult("run_20260830_130002")).steps[0].selectedTarget;
  assert.deepEqual(selected, { summary: "button Old action", role: "button", name: "Old action" });
});

test("missing fixture inputs and cancellation block safely while cleanup still runs", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveSimpleSpec(workspace, {
    fixtures: { before: ["login-customer"], after: ["cleanup-test-order"] },
  });
  const missingInput = await executeRun(runOptions(
    workspace,
    "run_20260830_130010",
    executor(),
  ));
  assert.equal(missingInput.classification, "blocked");
  assert.equal(missingInput.fixtures[0].status, "blocked");
  assert(missingInput.fixtures.some((fixture) => fixture.phase === "after"));

  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeRun(runOptions(
    workspace,
    "run_20260830_130011",
    executor(),
    {
      variables: { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "password" },
      signal: controller.signal,
    },
  ));
  assert.equal(cancelled.classification, "blocked");
  assert.match(cancelled.explanation, /Before fixture login-\[REDACTED\] blocked/);
});

test("between-step fixture failures block and preserve skipped test intent", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await workspace.saveFixture({
    version: 1,
    id: "open-menu",
    title: "Open menu",
    steps: [{ intent: "Open the utility menu" }],
    expect: ["The utility menu is visible"],
  });
  await saveSimpleSpec(workspace, {
    fixtures: { between: [{ afterStep: 1, fixtures: ["open-menu"] }] },
  });
  const result = await executeRun(runOptions(
    workspace,
    "run_20260830_130020",
    executor({
      act(intent, context) {
        if (context.scope === "fixture") return { status: "blocked", observation: `Cannot ${intent}` };
        return { outputs: ["ignored"] };
      },
    }),
  ));
  assert.equal(result.classification, "blocked");
  assert.match(result.explanation, /Between-step fixture open-menu blocked/);
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "skipped"]);
});

test("fixture observation failures and missing cleanup files are recorded separately", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveSimpleSpec(workspace, { fixtures: { after: ["cleanup-test-order"] } });
  const loadFixture = workspace.loadFixture.bind(workspace);
  let failCleanup = false;
  workspace.loadFixture = async (fixtureId) => {
    if (fixtureId === "cleanup-test-order" && failCleanup) {
      workspace.loadFixture = loadFixture;
      throw new Error("Cleanup fixture became unavailable");
    }
    return loadFixture(fixtureId);
  };
  const result = await executeRun(runOptions(
    workspace,
    "run_20260830_130030",
    executor({
      async act(_intent, context) {
        if (context.scope === "test") failCleanup = true;
        return {};
      },
      observe(expectation, context) {
        if (context.scope === "fixture") return { status: "failed" };
        return { status: "passed", observation: expectation };
      },
    }),
  ));
  assert.equal(result.classification, "passed");
  assert.equal(result.fixtures.at(-1).status, "blocked");
  assert.match(result.explanation, /Cleanup issue/);
});

test("screenshots accept files and base64 while invalid artifacts become capability notices", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  await saveSimpleSpec(workspace, {
    steps: [
      { intent: "Use the primary control", expect: ["The first outcome is visible"] },
      { intent: "Continue the journey", expect: ["The final outcome is visible"] },
      { intent: "Finish the journey", expect: ["The journey is complete"] },
      { intent: "Close the journey", expect: ["The journey is closed"] },
    ],
  });
  const sourceImage = path.join(root, "source.jpg");
  await writeFile(sourceImage, IMAGE);
  let captureIndex = 0;
  const result = await executeRun(runOptions(
    workspace,
    "run_20260830_130040",
    executor({
      screenshot() {
        captureIndex += 1;
        if (captureIndex === 1) return { path: sourceImage };
        if (captureIndex === 2) return { data: IMAGE.toString("base64"), encoding: "base64", extension: "WEBP" };
        if (captureIndex === 3) return null;
        return { data: "not-binary", extension: "gif" };
      },
    }),
  ));
  assert.equal(result.classification, "passed");
  assert.deepEqual(result.evidence.screenshots.map((name) => path.extname(name)), [".jpg", ".webp"]);
  assert(result.evidence.unsupported.some((notice) => /unsupported screenshot artifact/.test(notice)));
  for (const relativePath of result.evidence.screenshots) {
    assert.deepEqual(await readFile(path.join(workspace.runsDirectory, result.runId, relativePath)), IMAGE);
  }
});

test("inspection evidence is redacted and optional driver cleanup errors never replace the result", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveSimpleSpec(workspace);
  const events = [];
  const result = await executeRun(runOptions(
    workspace,
    "run_20260830_130050",
    executor({
      act: () => ({ outputs: { safe: "value" } }),
      consoleErrors: () => ["token-value in console"],
      networkErrors: () => [500],
      close: () => { throw new Error("close failed"); },
    }),
    {
      variables: { TOKEN: "token-value" },
      onEvent: async (event) => events.push(event.sequence),
      clock: () => 1788087600000,
    },
  ));
  assert.equal(result.classification, "passed");
  assert.deepEqual(result.evidence.consoleErrors, ["token-value in console"]);
  assert.deepEqual(result.evidence.networkErrors, ["500"]);
  assert.deepEqual(events, [...events].sort((left, right) => left - right));

  const inspectionFailure = await executeRun(runOptions(
    workspace,
    "run_20260830_130051",
    executor({ consoleErrors: () => { throw new Error("inspection failed"); } }),
  ));
  assert(inspectionFailure.evidence.unsupported.some((notice) => /inspection failed/.test(notice)));
});

test("environment resolution and connection errors persist blocked runs", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveSimpleSpec(workspace, { environment: "staging" });
  const unresolved = await executeRun({
    workspace,
    specId: "simple-journey",
    runId: "run_20260830_130060",
    executor: executor(),
    variables: {},
  });
  assert.equal(unresolved.classification, "blocked");
  assert.match(unresolved.explanation, /QA_STAGING_URL/);

  await saveSimpleSpec(workspace);
  const connection = await executeRun(runOptions(
    workspace,
    "run_20260830_130061",
    executor({ connect: () => { throw new Error("cannot connect"); } }),
  ));
  assert.equal(connection.classification, "blocked");
  assert.match(connection.explanation, /cannot connect/);

  await assert.rejects(
    () => executeRun(runOptions(
      workspace,
      "run_20260830_130062",
      executor(),
      { environmentId: "unknown" },
    )),
    (error) => error instanceof QaError && error.code === "UNKNOWN_ENVIRONMENT",
  );

  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeRun(runOptions(
    workspace,
    "run_20260830_130063",
    executor(),
    { signal: controller.signal },
  ));
  assert.equal(cancelled.classification, "blocked");
  assert.match(cancelled.explanation, /Run was cancelled/);
});

test("fixture observation exceptions become cleanup evidence", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveSimpleSpec(workspace, { fixtures: { after: ["cleanup-test-order"] } });
  const result = await executeRun(runOptions(
    workspace,
    "run_20260830_130070",
    executor({
      observe(_expectation, context) {
        if (context.scope === "fixture") throw new Error("postcondition unavailable");
        return true;
      },
    }),
  ));
  assert.equal(result.classification, "passed");
  assert.equal(result.fixtures[0].status, "failed");
  assert.match(result.fixtures[0].explanation, /postcondition unavailable/);
});

test("H4: failed fixture postconditions are functional regressions, never blocked or healed", async (t) => {
  // Fixture steps succeed but the postcondition assertion genuinely fails:
  // that is product signal, not environment noise.
  async function failingPostconditionSetup(phase) {
    const { workspace } = await temporaryWorkspace(t);
    await workspace.saveFixture({
      version: 1,
      id: "session-setup",
      title: "Establish the session",
      steps: [{ intent: "Prepare the session state" }],
      expect: ["The session is established"],
    });
    const fixtures = phase === "before"
      ? { before: ["session-setup"] }
      : { between: [{ afterStep: 1, fixtures: ["session-setup"] }] };
    await saveSimpleSpec(workspace, { fixtures });
    return workspace;
  }

  const failingObserve = (expectation) => (
    expectation === "The session is established"
      ? { status: "failed", observation: "The session is established was not observed" }
      : { status: "passed" }
  );

  const beforeWorkspace = await failingPostconditionSetup("before");
  const before = await executeRun(runOptions(
    beforeWorkspace,
    "run_20260830_130080",
    executor({ observe: failingObserve }),
  ));
  assert.equal(before.classification, "functional_regression");
  assert.match(before.explanation, /Before fixture session-setup failed/);
  assert.deepEqual(before.steps.map((step) => step.status), ["skipped", "skipped"]);
  assert.ok(!before.steps.some((step) => step.healing));

  const betweenWorkspace = await failingPostconditionSetup("between");
  const between = await executeRun(runOptions(
    betweenWorkspace,
    "run_20260830_130081",
    executor({ observe: failingObserve }),
  ));
  assert.equal(between.classification, "functional_regression");
  assert.match(between.explanation, /Between-step fixture session-setup failed/);
  assert.deepEqual(between.steps.map((step) => step.status), ["passed", "skipped"]);
  assert.ok(!between.steps.some((step) => step.healing));
});
