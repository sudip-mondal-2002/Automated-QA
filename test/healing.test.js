import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { runCli } from "../src/cli.js";
import {
  classifyFailure,
  createExpectationGuard,
  createNativeWebExecutor,
  executeRun,
  normalizeRediscovery,
  normalizeTarget,
  QaError,
} from "../src/index.js";
import { createDemoApplication } from "../demo-app/server.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { passingResult, temporaryWorkspace } from "../test-support/helpers.js";

const IMAGE = Buffer.from("healing-image");

async function pointLocalEnvironmentAt(workspace, baseUrl) {
  const environments = await workspace.loadEnvironments();
  environments.environments.local = { type: "web", baseUrl };
  await workspace.saveEnvironments(environments);
}

async function saveHealingSpec(workspace) {
  const spec = {
    version: 1,
    id: "healing-boundary",
    title: "Healing boundary",
    environment: "local",
    steps: [{ intent: "Use the checkout action", expect: ["Checkout form is visible"] }],
  };
  await workspace.saveSpec(spec);
  return spec;
}

test("failure classifier exposes conservative explicit outcomes", () => {
  const actionFailure = { stage: "action", status: "failed", explanation: "Target missing" };
  assert.equal(classifyFailure({ failure: actionFailure }).decision, "rediscover_target");
  assert.equal(classifyFailure({ failure: actionFailure, rediscovery: null }).classification, "functional_regression");
  assert.equal(classifyFailure({
    failure: actionFailure,
    rediscovery: { status: "found", equivalent: true, target: { summary: "Continue link" } },
  }).decision, "retry_equivalent_target");
  assert.equal(classifyFailure({
    failure: actionFailure,
    rediscovery: { status: "blocked", explanation: "UI unavailable" },
  }).classification, "blocked");
  assert.equal(classifyFailure({
    failure: { stage: "expectation", status: "failed" },
    readinessAvailable: true,
  }).decision, "wait_for_readiness");
  assert.equal(classifyFailure({
    failure: { stage: "expectation", status: "failed" },
  }).classification, "functional_regression");
  assert.equal(classifyFailure({
    failure: { stage: "action", status: "blocked", explanation: "Login required" },
  }).classification, "blocked");
  assert.equal(classifyFailure({ failure: actionFailure, verification: { status: "passed" } }).classification, "blocked");
  assert.equal(classifyFailure({
    failure: actionFailure,
    verification: { status: "passed" },
    recoveryAttempted: true,
  }).classification, "healed");
  assert.equal(classifyFailure({ failure: actionFailure, verification: { status: "failed" } }).classification, "functional_regression");
  assert.equal(classifyFailure({ failure: actionFailure, verification: { status: "blocked" } }).classification, "blocked");
  assert.equal(classifyFailure({ failure: actionFailure, expectationsUnchanged: false }).classification, "blocked");
  assert.equal(classifyFailure({
    failure: { stage: "action", status: "blocked" },
  }).reason, "Execution was blocked before recovery");
  assert.equal(classifyFailure({
    failure: actionFailure,
    rediscovery: { status: "blocked" },
  }).reason, "Target rediscovery was blocked");
  assert.equal(classifyFailure({
    failure: actionFailure,
    verification: { status: "blocked" },
  }).reason, "Recovery verification was blocked");
  assert.equal(classifyFailure({
    failure: actionFailure,
    verification: { status: "failed" },
  }).reason, "The original expectations still fail after recovery");
  assert.equal(classifyFailure({
    failure: { stage: "expectation", status: "failed" },
  }).reason, "The expected user-visible outcome failed");
  assert.equal(classifyFailure({
    failure: { stage: "action", status: "failed" },
    rediscovery: null,
  }).reason, "No safe equivalent target was found");
  assert.throws(
    () => classifyFailure(),
    (error) => error instanceof QaError && error.code === "INVALID_HEALING_INPUT",
  );
  assert.throws(
    () => classifyFailure({ failure: { stage: "design", status: "failed" } }),
    (error) => error instanceof QaError && error.code === "INVALID_HEALING_INPUT",
  );
  assert.throws(
    () => classifyFailure({ failure: { stage: "action", status: "unknown" } }),
    (error) => error instanceof QaError && error.code === "INVALID_HEALING_INPUT",
  );
  assert.throws(
    () => classifyFailure({ failure: actionFailure, verification: { status: "unknown" } }),
    (error) => error instanceof QaError && error.code === "INVALID_HEALING_INPUT",
  );
});

test("rediscovery normalization requires an explicitly equivalent accessible target", () => {
  assert.deepEqual(normalizeTarget({ role: "button", name: "Continue" }), {
    summary: "button Continue",
    role: "button",
    name: "Continue",
  });
  assert.equal(normalizeTarget(null), undefined);
  assert.equal(normalizeTarget({}), undefined);
  assert.deepEqual(normalizeTarget({ summary: 42 }), { summary: "42" });
  assert.equal(normalizeRediscovery(null).status, "ambiguous");
  assert.equal(normalizeRediscovery({ status: "unexpected" }).status, "ambiguous");
  assert.match(normalizeRediscovery({
    status: "found",
    target: { summary: "Possible target" },
  }).explanation, /not explicitly confirmed/);
  assert.match(normalizeRediscovery({ status: "found", equivalent: true }).explanation, /did not identify/);
  assert.deepEqual(normalizeRediscovery({
    status: "found",
    equivalent: true,
    target: { summary: "Continue link", role: "link", name: "Continue" },
    observation: 42,
  }), {
    status: "found",
    target: { summary: "Continue link", role: "link", name: "Continue" },
    equivalent: true,
    observation: "42",
  });
  assert.deepEqual(normalizeRediscovery({
    equivalent: true,
    selectedTarget: { role: "button", name: "Continue" },
    explanation: 7,
  }), {
    status: "found",
    target: { summary: "button Continue", role: "button", name: "Continue" },
    equivalent: true,
    explanation: "7",
  });
});

test("expectation guard detects byte or order changes", () => {
  const expectations = ["First outcome", "Second outcome"];
  const guard = createExpectationGuard(expectations);
  assert(Object.isFrozen(guard.expectations));
  assert.equal(guard.assertUnchanged(), true);
  expectations.reverse();
  assert.throws(
    () => guard.assertUnchanged(),
    (error) => error instanceof QaError && error.code === "EXPECTATION_MUTATED",
  );
  assert.throws(
    () => createExpectationGuard(["valid", 2]),
    (error) => error instanceof QaError && error.code === "INVALID_HEALING_INPUT",
  );
});

test("renamed and menu-wrapped checkout action heals with unchanged expectations and evidence", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication({ variant: "drift" });
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  await pointLocalEnvironmentAt(workspace, baseUrl);
  const beforeSpec = await workspace.loadSpec("checkout-card");
  const expectationSnapshot = JSON.stringify(beforeSpec.steps.map((step) => step.expect));

  const result = await executeRun({
    workspace,
    specId: "checkout-card",
    environmentId: "local",
    executor: demoNativeExecutor(),
    variables: { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "password" },
  });

  assert.equal(result.classification, "healed");
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "passed", "passed"]);
  assert.equal(result.steps[1].healing.strategy, "target_rediscovery");
  assert.equal(result.steps[1].healing.outcome, "healed");
  assert.match(result.steps[1].healing.originalFailure, /Previous target: Proceed to checkout link/);
  assert.match(result.steps[1].healing.replacement, /Continue to payment/);
  assert.match(result.steps[1].healing.verification, /original expectations passed unchanged/i);
  assert(result.events.some((event) => event.type === "healing_started"));
  assert(result.events.some((event) => event.type === "healing_completed" && event.status === "passed"));
  for (const evidence of [result.steps[1].healing.beforeScreenshot, result.steps[1].healing.afterScreenshot]) {
    assert(result.evidence.screenshots.includes(evidence));
    await readFile(path.join(workspace.runsDirectory, result.runId, evidence));
  }
  assert.equal(JSON.stringify((await workspace.loadSpec("checkout-card")).steps.map((step) => step.expect)), expectationSnapshot);
  assert.equal((await workspace.loadResult(result.runId)).classification, "healed");
});

test("a genuine broken outcome remains a functional regression after an earlier healed action", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication({ variant: "drift-broken" });
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  await pointLocalEnvironmentAt(workspace, baseUrl);
  const expectations = JSON.stringify((await workspace.loadSpec("checkout-card")).steps.map((step) => step.expect));

  const result = await executeRun({
    workspace,
    specId: "checkout-card",
    executor: demoNativeExecutor(),
    variables: { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "password" },
  });

  assert.equal(result.classification, "functional_regression");
  assert.equal(result.steps[1].healing.outcome, "healed");
  assert.equal(result.steps[2].status, "failed");
  assert(!result.steps[2].healing);
  assert.match(result.explanation, /Order confirmation is visible was not observed/);
  assert.equal(JSON.stringify((await workspace.loadSpec("checkout-card")).steps.map((step) => step.expect)), expectations);
});

test("ambiguous replacements are recorded but never acted on", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  let recoveries = 0;
  const executor = createNativeWebExecutor({
    act: () => ({
      status: "failed",
      observation: "Old action is missing",
      selectedTarget: { summary: "Old checkout action", role: "button", name: "Checkout" },
    }),
    observe: () => true,
    screenshot: () => IMAGE,
    rediscover: (intent, context) => {
      assert.equal(intent, "Use the checkout action");
      assert.equal(context.currentObservation, "Old action is missing");
      assert.equal(context.previousTarget.summary, "Old checkout action");
      assert.deepEqual(context.expectations, ["Checkout form is visible"]);
      assert(Object.isFrozen(context.expectations));
      return {
        status: "found",
        equivalent: false,
        target: { summary: "Delete account", role: "button", name: "Delete" },
      };
    },
    recover: () => { recoveries += 1; return {}; },
  });
  const result = await executeRun({
    workspace,
    specId: "healing-boundary",
    executor,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(result.classification, "functional_regression");
  assert.equal(result.steps[0].healing.outcome, "failed");
  assert.equal(recoveries, 0);
});

test("recovery cannot hide an expectation that still fails", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  let recovered = false;
  const executor = createNativeWebExecutor({
    act: () => ({ status: "failed", observation: "Old action is missing" }),
    rediscover: () => ({
      status: "found",
      equivalent: true,
      target: { summary: "Continue to payment", role: "button", name: "Continue to payment" },
    }),
    recover: () => { recovered = true; return {}; },
    observe: () => ({ status: "failed", observation: "Checkout form never appeared" }),
    screenshot: () => IMAGE,
  });
  const result = await executeRun({
    workspace,
    specId: "healing-boundary",
    executor,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(recovered, true);
  assert.equal(result.classification, "functional_regression");
  assert.equal(result.steps[0].healing.outcome, "failed");
  assert.match(result.steps[0].healing.verification, /Checkout form never appeared/);
});

test("observable readiness can heal without changing the expected outcome", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  let ready = false;
  const executor = createNativeWebExecutor({
    act: () => ({ selectedTarget: { summary: "Checkout action" } }),
    observe: () => ready,
    waitFor: () => { ready = true; return { status: "passed", observation: "Checkout form became visible" }; },
    screenshot: () => IMAGE,
  });
  const result = await executeRun({
    workspace,
    specId: "healing-boundary",
    executor,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(result.classification, "healed");
  assert.equal(result.steps[0].healing.strategy, "readiness_wait");
  assert.equal(result.steps[0].expectations[0].expectation, "Checkout form is visible");
});

test("CLI treats a healed run as a successful command", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  let ready = false;
  const output = [];
  const exitCode = await runCli(["run", "healing-boundary", "--root", root], {
    output: (line) => output.push(String(line)),
    error: (line) => output.push(String(line)),
    nativeExecutor: createNativeWebExecutor({
      act: () => ({}),
      observe: () => ready,
      waitFor: () => { ready = true; return true; },
      screenshot: () => IMAGE,
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(exitCode, 0);
  assert(output.some((line) => line.includes("\thealed\t")));
});

test("blocked rediscovery and missing healing screenshots fail safely", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  const blocked = await executeRun({
    workspace,
    specId: "healing-boundary",
    runId: "run_20260830_140000",
    executor: createNativeWebExecutor({
      act: () => ({ status: "failed", observation: "Target missing" }),
      observe: () => true,
      screenshot: () => IMAGE,
      rediscover: () => ({ status: "blocked", explanation: "The menu cannot be inspected" }),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(blocked.classification, "blocked");
  assert.equal(blocked.steps[0].healing.outcome, "blocked");

  let screenshotCalls = 0;
  const missingEvidence = await executeRun({
    workspace,
    specId: "healing-boundary",
    runId: "run_20260830_140001",
    executor: createNativeWebExecutor({
      act: () => ({ status: "failed", observation: "Target missing" }),
      observe: () => true,
      screenshot: () => (++screenshotCalls === 1 ? null : IMAGE),
      rediscover: () => ({
        status: "found",
        equivalent: true,
        target: { summary: "Equivalent checkout action" },
      }),
      recover: () => ({}),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(missingEvidence.classification, "blocked");
  assert.match(missingEvidence.explanation, /screenshot evidence is unavailable/);
});

test("rediscovery and replacement capability failures never become passes", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  const cases = [
    [
      "run_20260830_140020",
      { rediscover: () => { throw new Error("rediscovery crashed"); } },
      "functional_regression",
    ],
    [
      "run_20260830_140021",
      { rediscover: () => { throw new QaError("NATIVE_BLOCKED", "rediscovery unavailable"); } },
      "blocked",
    ],
    [
      "run_20260830_140022",
      {
        rediscover: () => ({ status: "found", equivalent: true, target: { summary: "Replacement" } }),
        recover: () => { throw new Error("replacement action crashed"); },
      },
      "functional_regression",
    ],
    [
      "run_20260830_140023",
      {
        rediscover: () => ({ status: "found", equivalent: true, target: { summary: "Replacement" } }),
        recover: () => ({ status: "blocked" }),
      },
      "blocked",
    ],
  ];
  for (const [runId, driver, classification] of cases) {
    const result = await executeRun({
      workspace,
      specId: "healing-boundary",
      runId,
      executor: createNativeWebExecutor({
        act: () => ({ status: "failed", observation: "Original target missing" }),
        observe: () => true,
        screenshot: () => IMAGE,
        ...driver,
      }),
      fetchImpl: async () => ({ status: 200 }),
    });
    assert.equal(result.classification, classification);
    assert.notEqual(result.steps[0].healing.outcome, "healed");
  }
});

test("readiness failures and unexpected recovery data block instead of guessing", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  const blockedWait = await executeRun({
    workspace,
    specId: "healing-boundary",
    runId: "run_20260830_140030",
    executor: createNativeWebExecutor({
      act: () => ({}),
      observe: () => false,
      waitFor: () => ({ status: "blocked", observation: "Page stopped responding" }),
      screenshot: () => IMAGE,
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(blockedWait.classification, "blocked");

  const throwingWait = await executeRun({
    workspace,
    specId: "healing-boundary",
    runId: "run_20260830_140031",
    executor: createNativeWebExecutor({
      act: () => ({}),
      observe: () => false,
      waitFor: () => { throw new Error("readiness unavailable"); },
      screenshot: () => IMAGE,
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(throwingWait.classification, "blocked");

  const throwingOutputs = {};
  Object.defineProperty(throwingOutputs, "value", {
    enumerable: true,
    get() { throw new Error("invalid recovery outputs"); },
  });
  const invalidRecovery = await executeRun({
    workspace,
    specId: "healing-boundary",
    runId: "run_20260830_140032",
    executor: createNativeWebExecutor({
      act: () => ({ status: "failed", observation: "Original target missing" }),
      observe: () => true,
      rediscover: () => ({ status: "found", equivalent: true, target: { summary: "Replacement" } }),
      recover: () => ({ outputs: throwingOutputs }),
      screenshot: () => IMAGE,
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(invalidRecovery.classification, "blocked");
  assert.match(invalidRecovery.steps[0].healing.verification, /invalid recovery outputs/);
});

test("a corrupt previous-run pointer does not prevent a fresh execution", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  await writeFile(workspace.lastTestPath, "not valid JSON");
  const result = await executeRun({
    workspace,
    specId: "healing-boundary",
    executor: createNativeWebExecutor({
      act: () => ({}),
      observe: () => true,
      screenshot: () => IMAGE,
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(result.classification, "passed");
});

test("a previous successful target is supplied as evidence for later rediscovery", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await saveHealingSpec(workspace);
  const first = await executeRun({
    workspace,
    specId: "healing-boundary",
    runId: "run_20260830_140040",
    executor: createNativeWebExecutor({
      act: () => ({ selectedTarget: { summary: "Original checkout button", role: "button", name: "Checkout" } }),
      observe: () => true,
      screenshot: () => IMAGE,
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(first.classification, "passed");

  let rediscoveryContext;
  const second = await executeRun({
    workspace,
    specId: "healing-boundary",
    runId: "run_20260830_140041",
    executor: createNativeWebExecutor({
      act: () => ({ status: "failed", observation: "The original control is absent" }),
      observe: () => true,
      screenshot: () => IMAGE,
      rediscover: (_intent, context) => {
        rediscoveryContext = context;
        return {
          status: "found",
          equivalent: true,
          target: { summary: "Continue to payment link", role: "link", name: "Continue to payment" },
        };
      },
      recover: () => ({}),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });

  assert.equal(second.classification, "healed");
  assert.deepEqual(rediscoveryContext.previousTarget, {
    summary: "Original checkout button",
    role: "button",
    name: "Checkout",
  });
  assert.match(second.steps[0].healing.originalFailure, /Previous target: Original checkout button/);
});

test("workspace refuses fabricated healed classifications and evidence", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const spec = await workspace.loadSpec("checkout-card");
  const step = {
    index: 1,
    intent: spec.steps[0].intent,
    status: "passed",
    expectations: spec.steps[0].expect.map((expectation) => ({ expectation, status: "passed" })),
  };
  await assert.rejects(
    () => workspace.saveResult(passingResult({ classification: "healed", steps: [step] })),
    (error) => error instanceof QaError && error.code === "HEALED_WITHOUT_RECOVERY",
  );

  const healing = {
    strategy: "target_rediscovery",
    outcome: "healed",
    originalFailure: "Old target missing",
    replacement: "Continue to payment",
    verification: "Original expectation passed unchanged",
    beforeScreenshot: "screenshots/before.png",
    afterScreenshot: "screenshots/after.png",
  };
  const result = passingResult({
    runId: "run_20260830_140010",
    classification: "healed",
    steps: [{ ...step, healing }],
    evidence: { screenshots: [] },
  });
  await assert.rejects(
    () => workspace.saveResult(result),
    (error) => error instanceof QaError && error.code === "MISSING_HEALING_EVIDENCE",
  );

  await workspace.saveScreenshot(result.runId, "before.png", IMAGE);
  await workspace.saveScreenshot(result.runId, "after.png", IMAGE);
  result.evidence.screenshots = ["screenshots/before.png", "screenshots/after.png"];
  result.classification = "passed";
  await assert.rejects(
    () => workspace.saveResult(result),
    (error) => error instanceof QaError && error.code === "HEALING_CLASSIFICATION_MISMATCH",
  );

  result.classification = "functional_regression";
  result.steps[0].status = "failed";
  result.steps[0].expectations[0].status = "failed";
  await assert.rejects(
    () => workspace.saveResult(result),
    (error) => error instanceof QaError && error.code === "HEALING_STATUS_MISMATCH",
  );

  result.classification = "healed";
  result.steps[0].status = "passed";
  result.steps[0].expectations[0].status = "passed";
  result.steps.push({
    index: 2,
    intent: spec.steps[1].intent,
    status: "failed",
    expectations: spec.steps[1].expect.map((expectation) => ({ expectation, status: "failed" })),
  });
  await assert.rejects(
    () => workspace.saveResult(result),
    (error) => error instanceof QaError && error.code === "HEALED_WITH_FAILED_STEP",
  );
});

test("demo variants reject unsupported states", () => {
  assert.throws(() => createDemoApplication({ variant: "unknown" }), /Unknown demo variant/);
});
