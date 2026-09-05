import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  inventoryEvidence,
  summarizeHealingRunnerScenarios,
  validateRegressionRunners,
} from "../benchmarks/qa/result.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_RUN = path.join(ROOT, "benchmarks/qa/results/codex-host-v1");
const HEALING_OPTIONS = {
  healingExpectations: { "reprobreak-1224": "The frozen product expectation" },
  healingCases: {
    "reprobreak-1224": { semanticIntent: "Exercise the frozen semantic action" },
  },
};
const REGRESSION_CANDIDATE = { id: "app:1", appId: "app", instruction: "Build it", expectation: "Save works" };
const REGRESSION_ARCHIVE = { appId: "app", bytes: 10, sha256: "a".repeat(64) };
const REGRESSION_OPTIONS = {
  regressionCandidates: { "app:1": REGRESSION_CANDIDATE },
  appArchives: { app: REGRESSION_ARCHIVE },
  regressionAssignments: { "app:1": { laneId: "lane-test", runner: "isolated-test-runner" } },
};

test("healing runner summaries preserve imperfect outcomes instead of censoring them", () => {
  const governance = {
    actionAttempts: 1,
    rediscoveryAttempts: 1,
    recoveryAttempts: 1,
    staleLocatorFailed: true,
    expectationsFrozen: true,
    expectationsUnchanged: true,
    equivalenceVerified: true,
    semanticAudit: "The live DOM was inspected against the unchanged semantic expectation.",
    beforeEvidenceExists: true,
    afterEvidenceExists: true,
  };
  const result = summarizeHealingRunnerScenarios([
    {
      ...governance,
      variant: "drift",
      expectedClassification: "healed",
      actualClassification: "functional_regression",
      healingOutcome: "failed",
      productOutcomePassed: false,
    },
    {
      ...governance,
      variant: "regression",
      expectedClassification: "functional_regression",
      actualClassification: "functional_regression",
      healingOutcome: "failed",
      productOutcomePassed: false,
    },
  ]);

  assert.equal(result.passed, false);
  assert.deepEqual(result.metrics.validHealRate, { correct: 0, total: 1, rate: 0 });
  assert.deepEqual(result.metrics.trueRegressionDetection, { correct: 1, total: 1, rate: 1 });
  assert.deepEqual(result.metrics.overall, { correct: 1, total: 2, rate: 0.5 });
});

test("regression runner manifests cannot weaken the frozen three-lane protocol", () => {
  const metadata = {
    regressionRunners: {
      schemaVersion: 1,
      strategy: "app-disjoint",
      runnerCount: 2,
      isolationEnforcement: "instruction-enforced",
      lanes: [
        { id: "lane-1", runner: "runner-1", caseIds: ["a:1"], appIds: ["a"] },
        { id: "lane-2", runner: "runner-2", caseIds: ["b:1"], appIds: ["b"] },
      ],
    },
  };
  assert.throws(
    () => validateRegressionRunners(
      metadata,
      [{ id: "a:1", appId: "a" }, { id: "b:1", appId: "b" }],
      { lanes: { regression: { runnerCount: 3 } } },
    ),
    /app-disjoint execution lanes/,
  );
});

async function seedEvidence(directory) {
  const published = JSON.parse(await readFile(path.join(SOURCE_RUN, "healing.json"), "utf8"));
  const recordedCase = published.find(({ caseId }) => caseId === "reprobreak-1224");
  const sources = [
    recordedCase.evidence.before[0],
    recordedCase.evidence.after[0],
    recordedCase.regressionControl.evidence.before[0],
    recordedCase.regressionControl.evidence.after[0],
  ];
  const scenario = async (name, offset, classification, healingOutcome) => {
    const scenarioDirectory = path.join(directory, name);
    await mkdir(path.join(scenarioDirectory, "screenshots"), { recursive: true });
    await copyFile(path.join(SOURCE_RUN, sources[offset]), path.join(scenarioDirectory, "screenshots/before.png"));
    await copyFile(path.join(SOURCE_RUN, sources[offset + 1]), path.join(scenarioDirectory, "screenshots/after.png"));
    const result = {
      version: 1,
      runId: name,
      specId: "reprobreak-1224",
      environment: "local",
      classification,
      steps: [{
        index: 1,
        intent: HEALING_OPTIONS.healingCases["reprobreak-1224"].semanticIntent,
        status: classification === "healed" ? "passed" : "failed",
        expectations: [{
          expectation: HEALING_OPTIONS.healingExpectations["reprobreak-1224"],
          status: classification === "healed" ? "passed" : "failed",
        }],
        healing: {
          strategy: "target_rediscovery",
          outcome: healingOutcome,
          originalFailure: "The old target no longer resolves",
          replacement: "the equivalent target",
          verification: "The frozen expectation was evaluated after recovery",
          beforeScreenshot: "screenshots/before.png",
          afterScreenshot: "screenshots/after.png",
        },
        selectedTarget: { summary: "the equivalent target" },
      }],
      evidence: { screenshots: ["screenshots/before.png", "screenshots/after.png"] },
      events: [
        { type: "healing_started", stepIndex: 1 },
        { type: "healing_completed", stepIndex: 1, status: classification === "healed" ? "passed" : "failed" },
      ],
    };
    const contents = `${JSON.stringify(result)}\n`;
    await writeFile(path.join(scenarioDirectory, "result.json"), contents);
    return {
      outcome: classification,
      retryPassed: classification === "healed",
      evidence: {
        before: [`${name}/screenshots/before.png`],
        after: [`${name}/screenshots/after.png`],
        failedTarget: "old target",
        replacement: "the equivalent target",
        execution: {
          result: `${name}/result.json`,
          sha256: createHash("sha256").update(contents).digest("hex"),
          classification,
          healingOutcome,
        },
      },
    };
  };
  const drift = await scenario("drift", 0, "healed", "healed");
  const control = await scenario("control", 2, "functional_regression", "failed");
  return [{
    caseId: "reprobreak-1224",
    ...drift,
    regressionControl: control,
  }];
}

async function seedImages(directory) {
  const submission = await seedEvidence(directory);
  return submission;
}

function inventoryByFile(inventory) {
  return new Map(inventory.map((item) => [item.file, item]));
}

async function overwriteAfterWithBefore(directory) {
  for (const name of ["drift", "control"]) {
    await copyFile(
      path.join(directory, name, "screenshots/before.png"),
      path.join(directory, name, "screenshots/after.png"),
    );
  }
}

async function regressionSubmission(directory, evidenceFile) {
  const evidence = await readFile(path.join(directory, evidenceFile));
  const notes = "The rendered application state was exercised and compared with the frozen expectation.";
  const trace = {
    schemaVersion: 1,
    caseId: "app:1",
    appId: "app",
    laneId: "lane-test",
    candidateSha256: createHash("sha256").update(JSON.stringify(REGRESSION_CANDIDATE)).digest("hex"),
    appArchiveSha256: REGRESSION_ARCHIVE.sha256,
    runner: "isolated-test-runner",
    browser: "test-browser 1",
    isolation: "A fresh browser context with empty storage was used for this case.",
    startedAt: "2026-09-05T12:00:00.000Z",
    completedAt: "2026-09-05T12:00:01.000Z",
    actions: ["Opened the rendered application and exercised Save"],
    observations: ["Captured the visible outcome after the action"],
    outcome: "Pass",
    confidence: "high",
    notes,
    evidence: [{
      file: evidenceFile,
      bytes: evidence.length,
      sha256: createHash("sha256").update(evidence).digest("hex"),
    }],
  };
  const contents = `${JSON.stringify(trace)}\n`;
  await writeFile(path.join(directory, "regression-trace.json"), contents);
  return [{
    caseId: "app:1",
    outcome: "Pass",
    confidence: "high",
    evidence: evidenceFile,
    notes,
    execution: {
      trace: "regression-trace.json",
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
  }];
}

test("QA result evidence is typed, case-unique, and byte-distinct across healing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-result-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const submission = await seedImages(directory);
  await writeFile(path.join(directory, "regression.txt"), "- region: QA evidence\n- button: Save\n- status: Saved successfully\n");
  const regression = await regressionSubmission(directory, "regression.txt");

  const inventory = await inventoryEvidence(
    directory,
    regression,
    submission,
    { ...HEALING_OPTIONS, ...REGRESSION_OPTIONS },
  );
  assert.equal(inventory.length, 8);
  assert.equal(inventory.filter((item) => item.kind === "png").length, 4);
  assert.equal(inventory.filter((item) => item.kind === "execution-json").length, 3);
  const byPath = inventoryByFile(inventory);
  assert.notEqual(byPath.get("drift/screenshots/before.png").sha256, byPath.get("drift/screenshots/after.png").sha256);
  assert.notEqual(byPath.get("control/screenshots/before.png").sha256, byPath.get("control/screenshots/after.png").sha256);
});

test("QA result evidence rejects metadata files and copied healing screenshots", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-result-rejection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const submission = await seedImages(directory);
  await writeFile(path.join(directory, "run.json"), `${JSON.stringify({ forged: true })}\n`);
  const regression = await regressionSubmission(directory, "run.json");

  await assert.rejects(
    inventoryEvidence(directory, regression, [], REGRESSION_OPTIONS),
    /image or semantic text snapshot/,
  );

  await overwriteAfterWithBefore(directory);
  await assert.rejects(
    inventoryEvidence(directory, [], submission, HEALING_OPTIONS),
    /byte-identical/,
  );
});

test("QA result evidence rejects a native execution record changed after submission", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-result-execution-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const submission = await seedEvidence(directory);
  await writeFile(path.join(directory, "drift/result.json"), `${JSON.stringify({ forged: true })}\n`);
  await assert.rejects(
    inventoryEvidence(directory, [], submission, HEALING_OPTIONS),
    /digest does not match/,
  );
});

test("QA result evidence cannot reuse a screenshot as an execution record", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-result-type-confusion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const submission = await seedEvidence(directory);
  const before = submission[0].evidence.before[0];
  submission[0].evidence.execution = {
    ...submission[0].evidence.execution,
    result: before,
    sha256: createHash("sha256").update(await readFile(path.join(directory, before))).digest("hex"),
  };
  await assert.rejects(
    inventoryEvidence(directory, [], submission, HEALING_OPTIONS),
    /reused across requirements/,
  );
});

test("QA result evidence binds the frozen expectation and its outcome status", async (t) => {
  const missingDirectory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-result-missing-expectation-"));
  const controlDirectory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-result-control-status-"));
  t.after(() => Promise.all([
    rm(missingDirectory, { recursive: true, force: true }),
    rm(controlDirectory, { recursive: true, force: true }),
  ]));

  const missingSubmission = await seedEvidence(missingDirectory);
  const missingPath = path.join(missingDirectory, missingSubmission[0].evidence.execution.result);
  const missingRecord = JSON.parse(await readFile(missingPath, "utf8"));
  missingRecord.steps[0].expectations = [];
  const missingContents = `${JSON.stringify(missingRecord)}\n`;
  await writeFile(missingPath, missingContents);
  missingSubmission[0].evidence.execution.sha256 = createHash("sha256").update(missingContents).digest("hex");
  await assert.rejects(
    inventoryEvidence(missingDirectory, [], missingSubmission, HEALING_OPTIONS),
    /preserve the frozen expectation/,
  );

  const controlSubmission = await seedEvidence(controlDirectory);
  const controlPath = path.join(controlDirectory, controlSubmission[0].regressionControl.evidence.execution.result);
  const controlRecord = JSON.parse(await readFile(controlPath, "utf8"));
  controlRecord.steps[0].expectations[0].status = "passed";
  const controlContents = `${JSON.stringify(controlRecord)}\n`;
  await writeFile(controlPath, controlContents);
  controlSubmission[0].regressionControl.evidence.execution.sha256 = createHash("sha256").update(controlContents).digest("hex");
  await assert.rejects(
    inventoryEvidence(controlDirectory, [], controlSubmission, HEALING_OPTIONS),
    /status contradicts/,
  );
});

test("QA result evidence binds healing lifecycle status to classification", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-result-healing-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const submission = await seedEvidence(directory);
  const resultPath = path.join(directory, submission[0].evidence.execution.result);
  const record = JSON.parse(await readFile(resultPath, "utf8"));
  record.steps[0].healing.outcome = "failed";
  const contents = `${JSON.stringify(record)}\n`;
  await writeFile(resultPath, contents);
  submission[0].evidence.execution.sha256 = createHash("sha256").update(contents).digest("hex");
  submission[0].evidence.execution.healingOutcome = "failed";
  await assert.rejects(
    inventoryEvidence(directory, [], submission, HEALING_OPTIONS),
    /no matching recovery event/,
  );
});

test("QA result evidence binds regression traces to candidates, archives, and evidence", async (t) => {
  const candidateDirectory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-regression-candidate-binding-"));
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-regression-evidence-binding-"));
  t.after(() => Promise.all([
    rm(candidateDirectory, { recursive: true, force: true }),
    rm(evidenceDirectory, { recursive: true, force: true }),
  ]));

  await writeFile(path.join(candidateDirectory, "evidence.txt"), "Rendered application state confirms the tested outcome after the recorded action.\n");
  const candidateSubmission = await regressionSubmission(candidateDirectory, "evidence.txt");
  const candidateTracePath = path.join(candidateDirectory, "regression-trace.json");
  const candidateTrace = JSON.parse(await readFile(candidateTracePath, "utf8"));
  candidateTrace.candidateSha256 = "0".repeat(64);
  const candidateTraceContents = `${JSON.stringify(candidateTrace)}\n`;
  await writeFile(candidateTracePath, candidateTraceContents);
  candidateSubmission[0].execution.sha256 = createHash("sha256").update(candidateTraceContents).digest("hex");
  await assert.rejects(
    inventoryEvidence(candidateDirectory, candidateSubmission, [], REGRESSION_OPTIONS),
    /does not match app:1/,
  );

  await writeFile(path.join(evidenceDirectory, "evidence.txt"), "Rendered application state confirms the tested outcome after the recorded action.\n");
  const evidenceSubmission = await regressionSubmission(evidenceDirectory, "evidence.txt");
  const evidenceTracePath = path.join(evidenceDirectory, "regression-trace.json");
  const evidenceTrace = JSON.parse(await readFile(evidenceTracePath, "utf8"));
  evidenceTrace.evidence[0].sha256 = "0".repeat(64);
  const evidenceTraceContents = `${JSON.stringify(evidenceTrace)}\n`;
  await writeFile(evidenceTracePath, evidenceTraceContents);
  evidenceSubmission[0].execution.sha256 = createHash("sha256").update(evidenceTraceContents).digest("hex");
  await assert.rejects(
    inventoryEvidence(evidenceDirectory, evidenceSubmission, [], REGRESSION_OPTIONS),
    /evidence digest is inconsistent/,
  );
});
