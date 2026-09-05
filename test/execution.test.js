import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createNativeDesktopExecutor,
  createNativeWebExecutor,
  executeRun,
  resolveReferences,
} from "../src/index.js";
import { createDemoApplication } from "../demo-app/server.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { temporaryWorkspace } from "../test-support/helpers.js";

const SCREENSHOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function pointLocalEnvironmentAt(workspace, baseUrl) {
  const environments = await workspace.loadEnvironments();
  environments.environments.local = { type: "web", baseUrl };
  await workspace.saveEnvironments(environments);
}

test("native execution runs login, test steps, cleanup, events, and screenshots end to end", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication();
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  await pointLocalEnvironmentAt(workspace, baseUrl);

  const result = await executeRun({
    workspace,
    specId: "checkout-card",
    environmentId: "local",
    executor: demoNativeExecutor(),
    variables: {
      QA_CUSTOMER_USERNAME: "customer@example.test",
      QA_CUSTOMER_PASSWORD: "not-persisted-password",
    },
  });

  assert.equal(result.classification, "passed");
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "passed", "passed"]);
  assert.deepEqual(result.fixtures.map(({ fixtureId, phase, status }) => ({ fixtureId, phase, status })), [
    { fixtureId: "login-customer", phase: "before", status: "passed" },
    { fixtureId: "cleanup-test-order", phase: "after", status: "passed" },
  ]);
  assert.equal(demo.state.orderCreated, false);
  assert(result.events.some((event) => event.type === "cleanup_completed"));
  assert(result.evidence.screenshots.length >= 5);
  for (const screenshot of result.evidence.screenshots) {
    await readFile(path.join(workspace.runsDirectory, result.runId, screenshot));
  }

  const persisted = await readFile(workspace.resultPath(result.runId), "utf8");
  assert(!persisted.includes("customer@example.test"));
  assert(!persisted.includes("not-persisted-password"));
  assert.deepEqual(await workspace.readLastTest(), {
    specId: "checkout-card",
    environment: "local",
    lastRunId: result.runId,
  });
});

test("after-fixture failure is recorded without overwriting a passing primary result", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication();
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  await pointLocalEnvironmentAt(workspace, baseUrl);
  const executor = demoNativeExecutor();
  const originalObserve = executor.driver.observe;
  executor.driver.observe = (expectation, context) => expectation === "The test order is absent"
    ? { status: "failed", observation: "Cleanup postcondition failed" }
    : originalObserve(expectation, context);

  const result = await executeRun({
    workspace,
    specId: "checkout-card",
    environmentId: "local",
    executor,
    variables: { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "secret" },
  });

  assert.equal(result.classification, "passed");
  assert.equal(result.fixtures.at(-1).status, "failed");
  assert.match(result.explanation, /Cleanup issue: cleanup-test-order failed/);
});

test("missing or mismatched native capabilities persist a clear blocked result", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const missing = await executeRun({ workspace, specId: "checkout-card", environmentId: "local" });
  assert.equal(missing.classification, "blocked");
  assert.match(missing.explanation, /No native Browser or Chrome capability/);
  assert.equal((await workspace.loadResult(missing.runId)).classification, "blocked");

  const desktop = createNativeDesktopExecutor({
    act() {},
    observe() {},
    screenshot() {},
  });
  const mismatched = await executeRun({
    workspace,
    specId: "checkout-card",
    environmentId: "local",
    executor: desktop,
  });
  assert.equal(mismatched.classification, "blocked");
  assert.match(mismatched.explanation, /requires a native web executor/);
});

test("fixture references resolve from environment variables and earlier outputs without logging values", () => {
  const resolved = resolveReferences({
    username: "${QA_CUSTOMER_USERNAME}",
    orderId: "${outputs.order.id}",
  }, {
    variables: { QA_CUSTOMER_USERNAME: "private-customer" },
    outputs: { order: { id: "QA-1001" } },
  });
  assert.deepEqual(resolved.value, { username: "private-customer", orderId: "QA-1001" });
  assert.deepEqual(new Set(resolved.sensitiveValues), new Set(["private-customer", "QA-1001"]));
});

test("native capability requires semantic action, observation, and screenshot support", async () => {
  const executor = createNativeWebExecutor({ act() {}, observe() {} });
  const availability = await executor.availability();
  assert.equal(availability.available, false);
  assert.match(availability.explanation, /screenshot/);
});

test("between-step fixtures consume earlier outputs at the declared boundary", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await workspace.saveFixture({
    version: 1,
    id: "remember-order",
    title: "Remember the created order",
    inputs: { orderId: "${outputs.order.id}" },
    steps: [{ intent: "Remember the created order" }],
    expect: ["The created order is remembered"],
  });
  await workspace.saveSpec({
    version: 1,
    id: "output-fixture-journey",
    title: "Output fixture journey",
    environment: "local",
    fixtures: { between: [{ afterStep: 1, fixtures: ["remember-order"] }] },
    steps: [
      { intent: "Create the order", expect: ["The order exists"] },
      { intent: "Finish the journey", expect: ["The journey is complete"] },
    ],
  });
  const calls = [];
  const executor = createNativeWebExecutor({
    act(intent, context) {
      calls.push(intent);
      if (intent === "Create the order") return { outputs: { order: { id: "private-order-id" } } };
      if (intent === "Remember the created order") assert.equal(context.inputs.orderId, "private-order-id");
      return {};
    },
    observe: () => ({ status: "passed" }),
    screenshot: () => SCREENSHOT,
  });
  const result = await executeRun({
    workspace,
    specId: "output-fixture-journey",
    executor,
    fetchImpl: async () => ({ status: 200 }),
  });

  assert.equal(result.classification, "passed");
  assert.deepEqual(calls, ["Create the order", "Remember the created order", "Finish the journey"]);
  assert.equal(result.fixtures[0].phase, "between");
  assert(!JSON.stringify(result).includes("private-order-id"));
});

test("an unreachable local target starts once and is stopped after execution", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  let reachable = false;
  let starts = 0;
  let stops = 0;
  const executor = createNativeWebExecutor({
    act: () => ({}),
    observe: () => ({ status: "passed" }),
    screenshot: () => SCREENSHOT,
  });
  const result = await executeRun({
    workspace,
    specId: "checkout-card",
    executor,
    variables: { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "password" },
    fetchImpl: async () => {
      if (!reachable) throw new Error("not ready");
      return { status: 200 };
    },
    startApplication: async () => {
      starts += 1;
      reachable = true;
      return { stop: async () => { stops += 1; } };
    },
  });

  assert.equal(result.classification, "passed");
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test("desktop environments use the computer-use executor boundary without web startup", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  let connectedTarget;
  const executor = createNativeDesktopExecutor({
    connect(target) { connectedTarget = target; },
    act: () => ({}),
    observe: () => ({ status: "passed" }),
    screenshot: () => SCREENSHOT,
  });
  const result = await executeRun({
    workspace,
    specId: "checkout-saved-card",
    environmentId: "desktop",
    executor,
    variables: {
      QA_DESKTOP_APP: "QA Shop Desktop",
      QA_CUSTOMER_USERNAME: "customer",
      QA_CUSTOMER_PASSWORD: "password",
    },
  });

  assert.equal(result.classification, "passed");
  assert.equal(connectedTarget.app, "QA Shop Desktop");
});
