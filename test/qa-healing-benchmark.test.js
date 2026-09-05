import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadHealingCases,
  runHealingBenchmark,
} from "../benchmarks/qa/healing/run.mjs";
import { renderFixture, startFixtureServer } from "../benchmarks/qa/healing/fixture-server.mjs";

const REDUCED_IDS = [1224, 1225, 616, 619, 3316, 3318, 5609, 5620];

async function chromeFamilyInstalled() {
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : process.platform === "win32"
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/chromium"];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {}
  }
  return false;
}

test("healing provenance freezes the official ReproBreak reduced records", async () => {
  const { dataset, sha256 } = await loadHealingCases();
  assert.equal(sha256, "c9c94b043ac6e6ab951a671d5aa6d148f8baa77bb9825e571c2daea26445dc7c");
  assert.equal(dataset.scope, "protocol-core");
  assert.deepEqual(dataset.source.selectedIds, REDUCED_IDS);
  assert.deepEqual(dataset.cases.map((benchmarkCase) => benchmarkCase.id), REDUCED_IDS);
  assert.equal(dataset.cases[0].source_record.old_locator, "cy.get('.slick-header-menu')");
  assert.equal(dataset.cases[0].source_record.new_locator, "cy.get('.slick-header-menu .slick-menu-command-list')");
  assert.equal(dataset.cases[2].source_record.old_locator, "page.$('[data-kg-floating-toolbar]'))");
  assert.equal(dataset.cases[4].source_record.new_locator, "page.getByRole('button', { name: 'Ok', exact: true })");
  assert.equal(dataset.cases[6].source_record.new_locator, "page.getByRole('treeitem')");
  assert.equal(dataset.cases[7].source_record.new_locator, "page.locator('.ui-mode-tree-item-title')");
  assert.match(dataset.claimBoundary, /not executions of the four upstream applications/i);
});

test("healing browser fixtures expose product UI without benchmark or locator oracles", async () => {
  const { dataset } = await loadHealingCases();
  for (const benchmarkCase of dataset.cases) {
    for (const variant of ["drift", "regression"]) {
      const fixture = renderFixture(benchmarkCase, variant);
      assert.equal(fixture.includes(benchmarkCase.source_record.old_locator), false);
      assert.equal(fixture.includes(benchmarkCase.source_record.new_locator), false);
      assert.doesNotMatch(fixture, /mechanical drift|true-regression control|functional_regression|expected classification/i);
      assert.doesNotMatch(fixture, /<title>[^<]*(?:drift|regression|ReproBreak)/i);
      assert.match(fixture, /<title>Interaction workspace<\/title>/);
      assert.match(fixture, /id="qa-outcome" data-status="pending">Ready for interaction<\/output>/);
    }
  }
});

test("healing fixture routes keep scenario classification server-side", async (t) => {
  const { dataset } = await loadHealingCases();
  const server = await startFixtureServer(dataset.cases);
  const secondServer = await startFixtureServer(dataset.cases);
  t.after(() => Promise.all([server.close(), secondServer.close()]));
  const driftUrl = server.urlFor(dataset.cases[0].id, "drift");
  const controlUrl = server.urlFor(dataset.cases[0].id, "regression");
  assert.notEqual(driftUrl, controlUrl);
  assert.notEqual(new URL(driftUrl).pathname, new URL(secondServer.urlFor(dataset.cases[0].id, "drift")).pathname);
  for (const url of [driftUrl, controlUrl]) {
    assert.match(new URL(url).pathname, /^\/scenario\/[a-f0-9]{32}$/);
    assert.doesNotMatch(new URL(url).pathname, /drift|regression/i);
    assert.equal((await fetch(url)).status, 200);
  }
});

test("healing core gets valid one-retry heals and rejects matched true regressions", { skip: !(await chromeFamilyInstalled()) }, async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-healing-benchmark-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const { dataset } = await loadHealingCases();
  const expectationById = new Map(dataset.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase.expectation]));

  const { summary } = await runHealingBenchmark({ outputDirectory });

  assert.equal(summary.passed, true);
  assert.deepEqual(summary.metrics.validHealRate, { correct: 8, total: 8, rate: 1 });
  assert.deepEqual(summary.metrics.falseHealRate, { count: 0, total: 8, rate: 0 });
  assert.deepEqual(summary.metrics.trueRegressionDetection, { correct: 8, total: 8, rate: 1 });
  assert.deepEqual(summary.metrics.oneRetryCompliance, { correct: 16, total: 16, rate: 1 });
  assert.deepEqual(summary.metrics.evidenceCompleteness, { correct: 16, total: 16, rate: 1 });
  assert.deepEqual(summary.metrics.unchangedExpectationProtection, { correct: 16, total: 16, rate: 1 });
  assert.deepEqual(summary.metrics.overall, { correct: 16, total: 16, rate: 1 });
  assert.notDeepEqual(
    summary.scenarios.map(({ caseId, variant }) => `${caseId}:${variant}`),
    REDUCED_IDS.flatMap((caseId) => [`${caseId}:drift`, `${caseId}:regression`]),
    "scenario execution order must be blinded rather than label-ordered",
  );

  for (const scenario of summary.scenarios) {
    assert.equal(scenario.passed, true, `scenario ${scenario.caseId}/${scenario.variant}`);
    assert.equal(scenario.actionAttempts, 1);
    assert.equal(scenario.rediscoveryAttempts, 1);
    assert.equal(scenario.recoveryAttempts, 1);
    assert.equal(scenario.staleLocatorFailed, true);
    assert.equal(scenario.equivalenceVerified, true);
    assert.ok(scenario.replacementTarget?.length > 0);
    assert.ok(scenario.semanticAudit?.length > 40);
    assert.notEqual(scenario.replacementTarget, scenario.newLocator);
    assert.equal(scenario.expectationsFrozen, true);
    assert.equal(scenario.expectationsUnchanged, true);
    assert.equal(scenario.beforeEvidenceExists, true);
    assert.equal(scenario.afterEvidenceExists, true);
    assert.equal(scenario.variant === "drift" ? scenario.healingOutcome : scenario.actualClassification, scenario.variant === "drift" ? "healed" : "functional_regression");
    assert.match(scenario.resultArtifact, /^\.qa\/runs\/run_[0-9]{8}_[0-9]{6}_[a-f0-9]{24}\/result\.json$/);
    assert.equal(scenario.resultArtifact.includes(String(scenario.caseId)), false);

    const resultPath = path.join(outputDirectory, ...scenario.resultArtifact.split("/"));
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.classification, scenario.expectedClassification);
    assert.deepEqual(result.steps[0].expectations.map((entry) => entry.expectation), [expectationById.get(scenario.caseId)]);
    const beforePath = path.join(path.dirname(resultPath), ...scenario.beforeEvidence.split("/"));
    const afterPath = path.join(path.dirname(resultPath), ...scenario.afterEvidence.split("/"));
    await access(beforePath);
    await access(afterPath);
    const beforeDigest = createHash("sha256").update(await readFile(beforePath)).digest("hex");
    const afterDigest = createHash("sha256").update(await readFile(afterPath)).digest("hex");
    assert.notEqual(beforeDigest, afterDigest, `evidence must show state change for ${scenario.caseId}/${scenario.variant}`);
  }

  const persisted = JSON.parse(await readFile(path.join(outputDirectory, "summary.json"), "utf8"));
  assert.deepEqual(persisted.metrics, summary.metrics);
  const submission = JSON.parse(await readFile(path.join(outputDirectory, "submission.json"), "utf8"));
  assert.equal(submission.length, 8);
  assert.equal(submission.every((entry) => entry.outcome === "healed" && entry.retryCount === 1), true);
  for (const entry of submission) {
    assert.equal(entry.actionAttempts, 1);
    assert.equal(entry.recoveryAttempts, 1);
    assert.equal(entry.expectationsFrozen, true);
    assert.equal(entry.beforeEvidenceExists, true);
    assert.equal(entry.afterEvidenceExists, true);
    assert.equal(entry.equivalenceVerified, true);
    assert.ok(entry.semanticAudit.length > 40);
    await access(path.join(outputDirectory, ...entry.evidence.before[0].split("/")));
    await access(path.join(outputDirectory, ...entry.evidence.after[0].split("/")));
    assert.ok(entry.evidence.semanticAudit.length > 40);
    assert.notEqual(entry.evidence.replacement, entry.evidence.failedTarget);
    assert.match(entry.evidence.execution.result, /^\.qa\/runs\/run_[0-9]{8}_[0-9]{6}_[a-f0-9]{24}\/result\.json$/);
    assert.match(entry.evidence.execution.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.evidence.execution.classification, "healed");
    assert.equal(entry.evidence.execution.healingOutcome, "healed");
    assert.equal(entry.regressionControl.outcome, "functional_regression");
    assert.equal(entry.regressionControl.breakReproduced, true);
    assert.equal(entry.regressionControl.actionAttempts, 1);
    assert.equal(entry.regressionControl.retryCount, 1);
    assert.equal(entry.regressionControl.recoveryAttempts, 1);
    assert.equal(entry.regressionControl.retryPassed, false);
    assert.equal(entry.regressionControl.equivalenceVerified, true);
    assert.equal(entry.regressionControl.expectationsUnchanged, true);
    assert.equal(entry.regressionControl.expectationsFrozen, true);
    assert.equal(entry.regressionControl.beforeEvidenceExists, true);
    assert.equal(entry.regressionControl.afterEvidenceExists, true);
    assert.ok(entry.regressionControl.semanticAudit.length > 40);
    assert.ok(entry.regressionControl.evidence.semanticAudit.length > 40);
    assert.match(entry.regressionControl.evidence.execution.result, /^\.qa\/runs\/run_[0-9]{8}_[0-9]{6}_[a-f0-9]{24}\/result\.json$/);
    assert.match(entry.regressionControl.evidence.execution.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.regressionControl.evidence.execution.classification, "functional_regression");
    assert.equal(entry.regressionControl.evidence.execution.healingOutcome, "failed");
    assert.notDeepEqual(entry.regressionControl.evidence.before, entry.evidence.before);
    assert.notDeepEqual(entry.regressionControl.evidence.after, entry.evidence.after);
    await access(path.join(outputDirectory, ...entry.regressionControl.evidence.before[0].split("/")));
    await access(path.join(outputDirectory, ...entry.regressionControl.evidence.after[0].split("/")));
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, "source-cases.json"), "utf8")).source.selectedIds, REDUCED_IDS);
  assert.match(await readFile(path.join(outputDirectory, "report.md"), "utf8"), /False heals: 0\/8 \(0\.0%\)/);
});
