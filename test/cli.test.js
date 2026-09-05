import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { QaWorkspace } from "../src/index.js";
import { createNativeWebExecutor } from "../src/index.js";

function capture() {
  const output = [];
  const errors = [];
  return {
    output,
    errors,
    io: {
      output: (value) => output.push(String(value)),
      error: (value) => errors.push(String(value)),
    },
  };
}

test("CLI initializes, creates from natural language, and selects the draft", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initCapture = capture();
  assert.equal(await runCli(["init", "--root", root], initCapture.io), 0);

  const createCapture = capture();
  assert.equal(await runCli([
    "create",
    "a logged-in customer completes checkout",
    "--id",
    "customer-checkout",
    "--env",
    "staging",
    "--expect",
    "Order confirmation is visible",
    "--root",
    root,
  ], createCapture.io), 0);

  const workspace = new QaWorkspace(root);
  const spec = await workspace.loadSpec("customer-checkout");
  assert.deepEqual(spec.fixtures.before, ["login-customer"]);
  assert.deepEqual(spec.steps[0].expect, ["Order confirmation is visible"]);
  assert.deepEqual(await workspace.readLastTest(), {
    specId: "customer-checkout",
    environment: "staging",
  });
  assert.match(await readFile(workspace.specPath(spec.id), "utf8"), /intent: Logged-in customer completes checkout/);
});

test("CLI surfaces path-based validation errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runCli(["init", "--root", root], capture().io);
  const result = capture();
  const exitCode = await runCli(["select", "missing-spec", "--root", root], result.io);
  assert.equal(exitCode, 1);
  assert.match(result.errors[0], /NOT_FOUND/);
  assert.match(result.errors[0], /file not found/);
});

test("CLI run-last repeats the selected spec and environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-run-last-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runCli(["init", "--root", root], capture().io);
  const executor = createNativeWebExecutor({
    act: () => ({}),
    observe: () => ({ status: "passed" }),
    screenshot: () => Buffer.from("screenshot"),
  });
  const result = capture();
  const exitCode = await runCli(["run-last", "--root", root], {
    ...result.io,
    nativeExecutor: executor,
    variables: { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "password" },
    fetchImpl: async () => ({ status: 200 }),
  });

  assert.equal(exitCode, 0);
  const workspace = new QaWorkspace(root);
  const selected = await workspace.readLastTest();
  assert.equal(selected.specId, "checkout-card");
  assert.equal(selected.environment, "local");
  assert.match(selected.lastRunId, /^run_/);
  assert(result.output.some((line) => line.includes("\tpassed\t")));
});
