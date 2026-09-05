import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, QaError, stringifyJson, stringifyYaml } from "../src/index.js";
import { canSymlink, passingResult, temporaryWorkspace } from "../test-support/helpers.js";

function recordedStep(spec, index = 1) {
  const step = spec.steps[index - 1];
  return {
    index,
    intent: step.intent,
    status: "passed",
    expectations: step.expect.map((expectation) => ({ expectation, status: "passed" })),
  };
}

test("workspace path guards and binary screenshot writes reject unsafe names", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  for (const operation of [
    () => workspace.fixturePath("../fixture"),
    () => workspace.specPath("BadSpec"),
  ]) {
    assert.throws(operation, (error) => error instanceof QaError && error.code === "INVALID_ID");
  }
  assert.throws(
    () => workspace.resultPath("run-invalid"),
    (error) => error instanceof QaError && error.code === "INVALID_RUN_ID",
  );
  assert.throws(
    () => workspace.screenshotPath("run_20260830_120000", "../image.png"),
    (error) => error instanceof QaError && error.code === "INVALID_SCREENSHOT_NAME",
  );

  const screenshot = await workspace.saveScreenshot("run_20260830_120000", "checkpoint.webp", new Uint8Array([1, 2, 3]));
  assert.equal(screenshot, "screenshots/checkpoint.webp");
  assert.deepEqual(await readFile(path.join(root, ".qa/runs/run_20260830_120000/screenshots/checkpoint.webp")), Buffer.from([1, 2, 3]));

  const target = path.join(root, "binary.bin");
  await atomicWriteFile(target, Buffer.from([4, 5]));
  assert.deepEqual(await readFile(target), Buffer.from([4, 5]));
});

test("workspace detects fixture and spec filename mismatches", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const fixture = await workspace.loadFixture("login-customer");
  fixture.id = "renamed-fixture";
  await writeFile(workspace.fixturePath("mismatched-fixture"), stringifyYaml(fixture));
  await assert.rejects(
    () => workspace.loadFixture("mismatched-fixture"),
    (error) => error instanceof QaError && error.code === "ID_MISMATCH",
  );
  await unlink(workspace.fixturePath("mismatched-fixture"));

  const spec = await workspace.loadSpec("checkout-card");
  spec.id = "renamed-spec";
  await writeFile(workspace.specPath("mismatched-spec"), stringifyYaml(spec));
  await assert.rejects(
    () => workspace.loadSpec("mismatched-spec"),
    (error) => error instanceof QaError && error.code === "ID_MISMATCH",
  );
});

test("workspace validates selection and last-run pointer consistency", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await assert.rejects(
    () => workspace.selectSpec("checkout-card", "unknown"),
    (error) => error instanceof QaError && error.code === "UNKNOWN_ENVIRONMENT",
  );

  const result = passingResult();
  await workspace.saveResult(result);
  await writeFile(workspace.lastTestPath, stringifyJson({
    specId: "checkout-saved-card",
    environment: "local",
    lastRunId: result.runId,
  }));
  await assert.rejects(
    () => workspace.readLastTest(),
    (error) => error instanceof QaError && error.code === "RUN_MISMATCH" && /another spec/.test(error.message),
  );

  await writeFile(workspace.lastTestPath, stringifyJson({
    specId: "checkout-card",
    environment: "staging",
    lastRunId: result.runId,
  }));
  await assert.rejects(
    () => workspace.readLastTest(),
    (error) => error instanceof QaError && error.code === "RUN_MISMATCH" && /different environments/.test(error.message),
  );

  const environments = await workspace.loadEnvironments();
  delete environments.environments.staging;
  await writeFile(workspace.environmentsPath, stringifyYaml(environments));
  await writeFile(workspace.lastTestPath, stringifyJson({ specId: "checkout-card", environment: "staging" }));
  await assert.rejects(
    () => workspace.readLastTest(),
    (error) => error instanceof QaError && error.code === "UNKNOWN_ENVIRONMENT",
  );
});

test("result persistence rejects every form of semantic contract drift", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const spec = await workspace.loadSpec("checkout-card");
  const base = (runId) => passingResult({ runId, steps: [recordedStep(spec)] });
  const invalidResults = [
    [
      { ...base("run_20260830_120010"), environment: "unknown" },
      "UNKNOWN_ENVIRONMENT",
    ],
    [
      { ...base("run_20260830_120011"), startedAt: "2026-08-30T12:00:03.000Z", completedAt: "2026-08-30T12:00:02.000Z" },
      "INVALID_RUN_TIME",
    ],
    [
      { ...base("run_20260830_120012"), steps: [recordedStep(spec), recordedStep(spec)] },
      "DUPLICATE_RESULT_STEP",
    ],
    [
      { ...base("run_20260830_120013"), steps: [{ ...recordedStep(spec), index: 99 }] },
      "UNKNOWN_RESULT_STEP",
    ],
    [
      { ...base("run_20260830_120014"), steps: [{ ...recordedStep(spec), intent: "A changed intent" }] },
      "RESULT_INTENT_CHANGED",
    ],
  ];

  for (const [result, code] of invalidResults) {
    await assert.rejects(
      () => workspace.saveResult(result),
      (error) => error instanceof QaError && error.code === code,
    );
  }
});

test("result listing ignores incomplete run directories and sorts completed runs", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(path.join(workspace.runsDirectory, "run_20260830_115959"), { recursive: true });
  await workspace.saveResult(passingResult({ runId: "run_20260830_120000" }));
  await workspace.saveResult(passingResult({
    runId: "run_20260830_120001",
    startedAt: "2026-08-30T12:00:04.000Z",
    completedAt: "2026-08-30T12:00:05.000Z",
  }));
  assert.deepEqual((await workspace.listResults()).map((result) => result.runId), [
    "run_20260830_120001",
    "run_20260830_120000",
  ]);
});

test("unselected specs can be deleted and validation tolerates a missing pointer", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await workspace.deleteSpec("checkout-saved-card");
  await assert.rejects(
    () => workspace.loadSpec("checkout-saved-card"),
    (error) => error instanceof QaError && error.code === "NOT_FOUND",
  );
  await unlink(workspace.lastTestPath);
  assert.equal((await workspace.validateAll()).lastTest, null);
});

test("non-ENOENT filesystem failures are not disguised as missing documents", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const fixturePath = workspace.fixturePath("login-customer");
  const movedPath = `${fixturePath}.saved`;
  await rename(fixturePath, movedPath);
  await mkdir(fixturePath);
  await assert.rejects(
    () => workspace.loadFixture("login-customer"),
    (error) => error.code === "EISDIR" || error.code === "EACCES",
  );
});

test("initialization propagates unexpected access failures", async (t) => {
  // Creating a symlink needs Developer Mode or elevation on Windows. The
  // behaviour under test is POSIX ELOOP propagation, so skip rather than fail
  // on a host policy difference.
  if (!(await canSymlink(t))) {
    t.skip("symlink creation is not permitted on this host");
    return;
  }
  const { root, workspace } = await temporaryWorkspace(t);
  await unlink(workspace.environmentsPath);
  await symlink(workspace.environmentsPath, workspace.environmentsPath);
  await assert.rejects(
    () => workspace.init(),
    (error) => error.code === "ELOOP",
  );
  assert(root);
});
