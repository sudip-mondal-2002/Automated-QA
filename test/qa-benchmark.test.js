import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORIES,
  DIMENSIONS,
  HEALING_IDS,
  assertCandidateSafe,
  createPreparedTrack,
  generationPredictionDigest,
  generationReference,
  generationReferenceDigest,
  parseCsv,
  scoreComposite,
  scoreGeneration,
  scoreHealing,
  scoreRegression,
  selectGenerationCases,
  selectRegressionCases,
} from "../benchmarks/qa/lib.mjs";

function fixtureRecords() {
  return CATEGORIES.flatMap((category, categoryIndex) => Array.from({ length: 3 }, (_, recordIndex) => ({
    index: `app-${categoryIndex}-${recordIndex}`,
    category,
    instruction: `Build ${category} app ${recordIndex}`,
    checklist: DIMENSIONS.flatMap((dimension, dimensionIndex) => [
      {
        id: `${dimensionIndex}-pass`,
        content: `${dimension} works`,
        class: dimension,
        pass: true,
      },
      {
        id: `${dimensionIndex}-fail`,
        content: `${dimension} defect is detected`,
        class: dimension,
        pass: false,
        bug: `hidden ${dimension} defect`,
      },
    ]),
  })));
}

function fixtureReproBreakRows() {
  return HEALING_IDS.map((id, index) => ({
    id: String(id),
    repository: `owner/repo-${index}`,
    old_locator: `old-${id}`,
    new_locator: `new-${id}`,
    category: "structural_break",
  }));
}

test("QA Core deterministically selects two generation apps per category", () => {
  const records = fixtureRecords();
  const first = selectGenerationCases(records);
  const reversed = selectGenerationCases([...records].reverse());
  assert.equal(first.length, 14);
  assert.deepEqual(first.map((item) => item.index), reversed.map((item) => item.index));
  for (const category of CATEGORIES) {
    assert.equal(first.filter((item) => item.category === category).length, 2);
  }
});

test("QA Core regression selection balances Pass and Fail across every category and dimension", () => {
  const first = selectRegressionCases(fixtureRecords());
  const reversed = selectRegressionCases(fixtureRecords().reverse());
  assert.equal(first.length, 56);
  assert.deepEqual(first.map((item) => item.id), reversed.map((item) => item.id));
  for (const category of CATEGORIES) {
    for (const dimension of DIMENSIONS) {
      const cell = first.filter((item) => item.category === category && item.dimension === dimension);
      assert.deepEqual(cell.map((item) => item.expectedOutcome).sort(), ["Fail", "Pass"]);
    }
  }
  assert.notDeepEqual(
    first.map((item) => item.expectedOutcome),
    Array.from({ length: 28 }, () => ["Pass", "Fail"]).flat(),
    "candidate order must not reveal the balanced pair construction",
  );
});

test("QA Core candidate views never leak verdicts, bug notes, or replacement locators", () => {
  const prepared = createPreparedTrack(fixtureRecords(), fixtureReproBreakRows());
  assert.equal(prepared.candidates.generation.length, 14);
  assert.equal(prepared.candidates.regression.length, 56);
  assert.equal(prepared.candidates.healing.length, 8);
  assert.doesNotThrow(() => assertCandidateSafe(prepared.candidates));
  assert.equal(JSON.stringify(prepared.candidates).includes("hidden"), false);
  assert.equal(JSON.stringify(prepared.candidates).includes("new-1224"), false);
  assert.equal(prepared.candidates.regression.some((item) => "category" in item || "dimension" in item), false);
  assert.throws(() => assertCandidateSafe({ nested: { pass: true } }), /leaks hidden field/);
  assert.throws(() => assertCandidateSafe({ nested: { expectedOutcome: "Fail" } }), /leaks hidden field/);
});

test("QA Core parses quoted ReproBreak locator CSV without corrupting commas or quotes", () => {
  const rows = parseCsv('id,repository,old_locator,new_locator,category\r\n1,o/r,"get(""a,b"")","get(""c"")",structural_break\r\n');
  assert.deepEqual(rows, [{
    id: "1",
    repository: "o/r",
    old_locator: 'get("a,b")',
    new_locator: 'get("c")',
    category: "structural_break",
  }]);
});

test("QA Core generation scoring follows upstream many-to-one checklist alignment", () => {
  const referenceCases = [{
    id: "app",
    category: "Tool",
    instruction: "Build it",
    checklist: [
      { id: "g1", content: "one", dimension: "functionality" },
      { id: "g2", content: "two", dimension: "constraint" },
    ],
  }];
  const tests = [
    { id: "p1", class: "functionality", description: "one", action: "do one", expected: "one works" },
    { id: "p2", class: "constraint", description: "two", action: "do two", expected: "two works" },
    { id: "p3", class: "functionality", description: "one detail", action: "do one detail", expected: "detail works" },
  ];
  const predictions = [{ taskId: "app", tests }];
  const mapping = (candidateId, referenceId) => ({
    taskId: "app",
    candidateId,
    referenceId,
    judge: "independent-judge",
    rationale: "The candidate and gold requirement align.",
    candidateSha256: generationPredictionDigest(tests.find((item) => item.id === candidateId)),
    referenceSha256: generationReferenceDigest(referenceCases[0].checklist.find((item) => item.id === referenceId)),
  });
  const mappings = [mapping("p1", "g1"), mapping("p2", "g2"), mapping("p3", "g1")];
  const metrics = scoreGeneration({ referenceCases, predictions, mappings });
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.f1, 1);
  assert.equal(metrics.coverage, 1);
  assert.equal(metrics.judgmentCoverage, 1);
  assert.throws(() => scoreGeneration({
    referenceCases,
    predictions,
    mappings: [
      mapping("p1", "g1"),
      mapping("p1", "g2"),
    ],
  }), /judged more than once/);
  assert.throws(() => scoreGeneration({
    referenceCases,
    predictions,
    mappings: [{ ...mapping("p1", "g1"), candidateSha256: "0".repeat(64) }],
  }), /not bound to the generated test text/);
  assert.throws(() => scoreGeneration({
    referenceCases,
    predictions: [{
      taskId: "app",
      tests: [tests[0], { ...tests[0], id: "duplicate-content" }],
    }],
    mappings: [],
  }), /repeats identical test content/);
});

test("QA Core regression scoring uses Fail as positive and penalizes blocked cases", () => {
  const referenceCases = [
    { id: "tp", expectedOutcome: "Fail" },
    { id: "fn", expectedOutcome: "Fail" },
    { id: "tn", expectedOutcome: "Pass" },
    { id: "blocked-negative", expectedOutcome: "Pass" },
  ];
  const metrics = scoreRegression({
    referenceCases,
    predictions: [
      { caseId: "tp", outcome: "Fail" },
      { caseId: "fn", outcome: "Pass" },
      { caseId: "tn", outcome: "Pass" },
      { caseId: "blocked-negative", outcome: "blocked" },
    ],
  });
  assert.equal(metrics.truePositive, 1);
  assert.equal(metrics.falseNegative, 1);
  assert.equal(metrics.trueNegative, 1);
  assert.equal(metrics.abstainedNegative, 1);
  assert.equal(metrics.recall, 0.5);
  assert.equal(metrics.specificity, 0.5);
  assert.equal(metrics.accuracy, 0.5);
  assert.equal(metrics.coverage, 0.75);
});

function completeHeal(caseId, overrides = {}) {
  return {
    caseId,
    outcome: "healed",
    breakReproduced: true,
    actionAttempts: 1,
    retryCount: 1,
    recoveryAttempts: 1,
    retryPassed: true,
    equivalenceVerified: true,
    expectationsUnchanged: true,
    expectationsFrozen: true,
    beforeEvidenceExists: true,
    afterEvidenceExists: true,
    evidence: {
      before: ["before.png"],
      after: ["after.png"],
      failedTarget: "old target",
      replacement: "new target",
      strategy: "same role and accessible name",
      retryOutcome: "passed",
      verification: "all original assertions passed",
    },
    regressionControl: {
      outcome: "functional_regression",
      breakReproduced: true,
      actionAttempts: 1,
      retryCount: 1,
      recoveryAttempts: 1,
      retryPassed: false,
      equivalenceVerified: true,
      expectationsUnchanged: true,
      expectationsFrozen: true,
      beforeEvidenceExists: true,
      afterEvidenceExists: true,
      evidence: {
        before: ["control-before.png"],
        after: ["control-after.png"],
        failedTarget: "old target",
        replacement: "new target",
        strategy: "same role and accessible name",
        retryOutcome: "functional_regression",
        verification: "the unchanged assertion still failed",
      },
    },
    ...overrides,
  };
}

test("QA Core healing scoring rejects unsafe claims and composite hard gates override averages", () => {
  const referenceCases = [{ id: "h1" }, { id: "h2" }];
  const healing = scoreHealing({
    referenceCases,
    predictions: [
      completeHeal("h1"),
      completeHeal("h2", { expectationsUnchanged: false }),
    ],
  });
  assert.equal(healing.claimedHeals, 2);
  assert.equal(healing.safeHeals, 1);
  assert.equal(healing.invalidHealClaims, 1);
  assert.equal(healing.falseHealRate, 0);
  assert.equal(healing.healRecall, 0.5);
  assert.equal(healing.trueRegressionDetection, 1);
  assert.equal(healing.unchangedExpectations, 0.75);

  const composite = scoreComposite({
    generation: { f1: 0.9, judgmentCoverage: 1 },
    regression: { f1: 0.9, specificity: 0.9, coverage: 1 },
    healing,
  });
  assert.equal(composite.eligible, false);
  assert.equal(composite.score, 0);
  assert.ok(composite.rawScore > 0);
});

test("QA Core healing scoring counts a healed behavior failure as a false heal", () => {
  const prediction = completeHeal("h1");
  prediction.regressionControl.outcome = "healed";
  const metrics = scoreHealing({ referenceCases: [{ id: "h1" }], predictions: [prediction] });
  assert.equal(metrics.safeHeals, 1);
  assert.equal(metrics.falseHeals, 1);
  assert.equal(metrics.falseHealRate, 1);
  assert.equal(metrics.trueRegressionDetection, 0);
  assert.equal(metrics.safetyScore, 0);
});

test("QA Core healing scoring rejects extra action or recovery attempts", () => {
  const prediction = completeHeal("h1", { actionAttempts: 2, recoveryAttempts: 2 });
  const healing = scoreHealing({ referenceCases: [{ id: "h1" }], predictions: [prediction] });
  const composite = scoreComposite({
    generation: { f1: 1, judgmentCoverage: 1 },
    regression: { f1: 1, specificity: 1, coverage: 1 },
    healing,
  });

  assert.equal(healing.safeHeals, 0);
  assert.equal(healing.invalidHealClaims, 1);
  assert.equal(healing.safetyScore, 0);
  assert.equal(composite.eligible, false);
  assert.equal(composite.score, 0);
});

test("QA Core exposes generation references without hidden defect outcomes", () => {
  const reference = generationReference(fixtureRecords()[0]);
  assert.ok(reference.checklist.length > 0);
  assert.equal(reference.checklist.some((item) => "pass" in item || "bug" in item), false);
});
