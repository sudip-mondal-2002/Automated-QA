import assert from "node:assert/strict";
import test from "node:test";
import { createDemoApplication } from "../demo-app/server.js";
import { resetRunningDemo } from "../demo-app/reset.js";
import { executeRun } from "../src/index.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { temporaryWorkspace } from "../test-support/helpers.js";

async function pointLocalEnvironmentAt(workspace, baseUrl) {
  const environments = await workspace.loadEnvironments();
  environments.environments.local = { type: "web", baseUrl };
  await workspace.saveEnvironments(environments);
}

test("live corner demo exposes D1, H1, H2, H3, H4, H7, and E5 as deterministic states", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const app = createDemoApplication();
  t.after(() => app.stop());
  const baseUrl = await app.start(0);
  await pointLocalEnvironmentAt(workspace, baseUrl);

  const run = async (scenario) => {
    await resetRunningDemo({ scenario, baseUrl });
    return executeRun({
      workspace,
      specId: "checkout-card",
      environmentId: "local",
      executor: demoNativeExecutor(),
      variables: {
        QA_CUSTOMER_USERNAME: "customer",
        QA_CUSTOMER_PASSWORD: "not-persisted-password",
      },
    });
  };

  const pass = await run("pass");
  assert.equal(pass.classification, "passed");
  assert.equal(pass.design, undefined);

  const drift = await run("drift");
  assert.equal(drift.classification, "healed");
  assert.equal(drift.steps[1].healing.outcome, "healed");

  const missingTarget = await run("missing-target");
  assert.equal(missingTarget.classification, "functional_regression");
  assert.match(missingTarget.steps[1].healing.verification, /No equivalent control was found/);

  const functional = await run("functional");
  assert.equal(functional.classification, "functional_regression");
  assert.equal(functional.steps[2].status, "failed");
  assert.equal(functional.steps[2].healing, undefined);

  const fixture = await run("fixture");
  assert.equal(fixture.classification, "functional_regression");
  assert.equal(fixture.fixtures[0].phase, "before");
  assert.equal(fixture.fixtures[0].status, "failed");
  assert(fixture.steps.every((step) => step.status === "skipped"));

  const laterFailure = await run("drift-functional");
  assert.equal(laterFailure.classification, "functional_regression");
  assert.equal(laterFailure.steps[1].healing.outcome, "healed");
  assert.equal(laterFailure.steps[2].status, "failed");

  const cleanup = await run("cleanup");
  assert.equal(cleanup.classification, "passed");
  assert.equal(cleanup.fixtures.at(-1).phase, "after");
  assert.equal(cleanup.fixtures.at(-1).status, "failed");
  assert.match(cleanup.explanation, /Cleanup issue: cleanup-test-order failed/);
});
