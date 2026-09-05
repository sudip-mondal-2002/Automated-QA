import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, QaError } from "../src/index.js";
import { passingResult, temporaryWorkspace } from "../test-support/helpers.js";

test("init creates and validates the complete seeded workspace", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const summary = await workspace.validateAll();

  assert.deepEqual(
    { environments: summary.environments, fixtures: summary.fixtures, specs: summary.specs, runs: summary.runs },
    { environments: 3, fixtures: 2, specs: 3, runs: 0 },
  );
  assert.deepEqual(summary.lastTest, { specId: "checkout-card", environment: "local" });
  await Promise.all([
    readFile(path.join(root, ".qa/environments.yaml")),
    readFile(path.join(root, ".qa/fixtures/login-customer.yaml")),
    readFile(path.join(root, ".qa/fixtures/cleanup-test-order.yaml")),
    readFile(path.join(root, ".qa/specs/checkout-card.yaml")),
  ]);
});

test("init is idempotent and preserves existing editable YAML", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const spec = await workspace.loadSpec("checkout-card");
  spec.title = "Manually edited checkout";
  await workspace.saveSpec(spec);

  const outcome = await workspace.init();
  assert.equal((await workspace.loadSpec("checkout-card")).title, "Manually edited checkout");
  assert.equal(outcome.created.length, 0);
  assert.equal(outcome.skipped.length, 7);
});

test("spec and fixture CRUD remains reference-safe", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const fixture = {
    version: 1,
    id: "dismiss-cookie-dialog",
    title: "Dismiss the cookie dialog",
    steps: [{ intent: "Dismiss the cookie dialog if it is visible" }],
    expect: ["The cookie dialog is absent"],
    idempotent: true,
  };
  await workspace.saveFixture(fixture);
  assert.equal((await workspace.loadFixture(fixture.id)).title, fixture.title);

  const spec = {
    version: 1,
    id: "browse-catalog",
    title: "Customer browses the catalog",
    environment: "local",
    fixtures: { before: [fixture.id] },
    steps: [{ intent: "Open the catalog", expect: ["Products are visible"] }],
  };
  await workspace.saveSpec(spec);
  assert((await workspace.listSpecs()).some((entry) => entry.id === spec.id));

  spec.title = "Customer browses available products";
  await workspace.saveSpec(spec);
  assert.equal((await workspace.loadSpec(spec.id)).title, spec.title);

  await assert.rejects(
    () => workspace.deleteFixture(fixture.id),
    (error) => error instanceof QaError && error.code === "FIXTURE_IN_USE",
  );
  await workspace.deleteSpec(spec.id);
  await workspace.deleteFixture(fixture.id);
  assert(!(await workspace.listFixtures()).some((entry) => entry.id === fixture.id));
});

test("unknown fixture and environment references fail before save", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const baseSpec = {
    version: 1,
    id: "broken-reference",
    title: "Broken reference",
    environment: "unknown-env",
    steps: [{ intent: "Open the app", expect: ["The app is visible"] }],
  };

  await assert.rejects(
    () => workspace.saveSpec(baseSpec),
    (error) => error instanceof QaError && error.code === "UNKNOWN_ENVIRONMENT" && error.issues[0].path === "$.environment",
  );

  baseSpec.environment = "local";
  baseSpec.fixtures = { before: ["missing-login"] };
  await assert.rejects(
    () => workspace.saveSpec(baseSpec),
    (error) => error instanceof QaError && error.code === "UNKNOWN_FIXTURE",
  );
});

test("between-step fixtures are accepted only at meaningful boundaries", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const spec = {
    version: 1,
    id: "two-part-journey",
    title: "Two part journey",
    environment: "local",
    fixtures: {
      between: [{ afterStep: 1, fixtures: ["login-customer"] }],
    },
    steps: [
      { intent: "Open the public page", expect: ["Public content is visible"] },
      { intent: "Open the account", expect: ["Customer dashboard is visible"] },
    ],
  };
  await workspace.saveSpec(spec);
  spec.fixtures.between[0].afterStep = 2;
  await assert.rejects(
    () => workspace.saveSpec(spec),
    (error) => error instanceof QaError && error.code === "INVALID_FIXTURE_POSITION",
  );
  spec.fixtures.between[0].afterStep = 1;
  spec.design = { reference: "https://design.example/approved.png", afterStep: 3 };
  await assert.rejects(
    () => workspace.saveSpec(spec),
    (error) => error instanceof QaError && error.code === "INVALID_DESIGN_POSITION",
  );
});

test("environment updates cannot strand existing specs", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await assert.rejects(
    () => workspace.saveEnvironments({
      version: 1,
      environments: { staging: { type: "web", baseUrl: "${QA_STAGING_URL}" } },
    }),
    (error) => error instanceof QaError && error.code === "ENVIRONMENT_IN_USE",
  );
  assert(Object.hasOwn((await workspace.loadEnvironments()).environments, "local"));
});

test("last-test selection is atomic and resolves to a real spec", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const original = await readFile(workspace.lastTestPath, "utf8");
  await assert.rejects(
    () => workspace.selectSpec("missing-spec", "local"),
    (error) => error instanceof QaError && error.code === "NOT_FOUND",
  );
  assert.equal(await readFile(workspace.lastTestPath, "utf8"), original);

  await workspace.selectSpec("checkout-card", "staging");
  assert.deepEqual(await workspace.readLastTest(), {
    specId: "checkout-card",
    environment: "staging",
  });
});

test("invalid updates do not alter an existing spec", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const before = await readFile(workspace.specPath("checkout-card"), "utf8");
  await assert.rejects(
    () => workspace.saveSpec("version: 1\nid: checkout-card\nsteps: ["),
    (error) => error instanceof QaError && error.code === "INVALID_YAML",
  );
  assert.equal(await readFile(workspace.specPath("checkout-card"), "utf8"), before);
});

test("atomic write failures preserve the target and clean temporary files", async (t) => {
  const { root } = await temporaryWorkspace(t);
  const target = path.join(root, "atomic-target.txt");
  await writeFile(target, "original", "utf8");

  await assert.rejects(
    () => atomicWriteFile(target, { not: "valid file contents" }),
    (error) => error instanceof QaError && error.code === "ATOMIC_WRITE_FAILED",
  );
  assert.equal(await readFile(target, "utf8"), "original");
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("completed results update last-test and preserve expectations", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const checkout = await workspace.loadSpec("checkout-card");
  const firstStep = checkout.steps[0];
  const result = passingResult({
    steps: [{
      index: 1,
      intent: firstStep.intent,
      status: "passed",
      expectations: firstStep.expect.map((expectation) => ({ expectation, status: "passed" })),
      selectedTarget: { summary: "Shopping cart link", role: "link", name: "Cart" },
    }],
  });
  await workspace.saveResult(result);

  assert.equal((await workspace.loadResult(result.runId)).classification, "passed");
  assert.deepEqual(await workspace.readLastTest(), {
    specId: "checkout-card",
    environment: "local",
    lastRunId: result.runId,
  });
  assert.equal((await workspace.listResults())[0].runId, result.runId);

  result.runId = "run_20260830_120001";
  result.steps[0].expectations[0].expectation = "Anything passes";
  await assert.rejects(
    () => workspace.saveResult(result),
    (error) => error instanceof QaError && error.code === "RESULT_EXPECTATION_CHANGED",
  );
});

test("results cannot invent fixture executions or missing screenshot evidence", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const inventedFixture = passingResult({
    fixtures: [{ fixtureId: "login-customer", phase: "after", status: "passed" }],
  });
  await assert.rejects(
    () => workspace.saveResult(inventedFixture),
    (error) => error instanceof QaError && error.code === "UNKNOWN_RESULT_FIXTURE",
  );

  const missingScreenshot = passingResult({
    runId: "run_20260830_120001",
    evidence: { screenshots: ["screenshots/001-checkpoint.png"] },
  });
  await assert.rejects(
    () => workspace.saveResult(missingScreenshot),
    (error) => error instanceof QaError && error.code === "MISSING_SCREENSHOT",
  );
});

test("the selected spec cannot be deleted into a broken pointer", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await assert.rejects(
    () => workspace.deleteSpec("checkout-card"),
    (error) => error instanceof QaError && error.code === "SPEC_SELECTED",
  );
});
