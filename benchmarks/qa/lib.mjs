import { createHash } from "node:crypto";

export const TRACK_ID = "qa-core-v1";
export const GENERATION_SEED = `${TRACK_ID}:generation`;
export const REGRESSION_SEED = `${TRACK_ID}:regression`;

export const CATEGORIES = Object.freeze([
  "Presentation",
  "Search",
  "Tool",
  "Commerce",
  "Data Management",
  "Workflow",
  "User-Generated Content",
]);

export const DIMENSIONS = Object.freeze([
  "functionality",
  "constraint",
  "interaction",
  "content",
]);

export const HEALING_IDS = Object.freeze([1224, 1225, 616, 619, 3316, 3318, 5609, 5620]);

const FORBIDDEN_CANDIDATE_KEYS = new Set([
  "pass",
  "bug",
  "expectedOutcome",
  "expectedClassification",
  "new_locator",
  "newLocator",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableRank(seed, key) {
  return sha256(`${seed}:${key}`);
}

function compareByRank(seed, keyOf) {
  return (left, right) => {
    const leftKey = String(keyOf(left));
    const rightKey = String(keyOf(right));
    return stableRank(seed, leftKey).localeCompare(stableRank(seed, rightKey))
      || leftKey.localeCompare(rightKey);
  };
}

function assertWebTestBenchRecords(records) {
  if (!Array.isArray(records)) throw new TypeError("WebTestBench records must be an array");
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object") throw new TypeError("Invalid WebTestBench record");
    if (typeof record.index !== "string" || !record.index) throw new Error("WebTestBench record has no index");
    if (ids.has(record.index)) throw new Error(`Duplicate WebTestBench index: ${record.index}`);
    ids.add(record.index);
    if (!CATEGORIES.includes(record.category)) {
      throw new Error(`Unknown WebTestBench category for ${record.index}: ${record.category}`);
    }
    if (typeof record.instruction !== "string" || !record.instruction.trim()) {
      throw new Error(`WebTestBench record has no instruction: ${record.index}`);
    }
    if (!Array.isArray(record.checklist) || record.checklist.length === 0) {
      throw new Error(`WebTestBench record has no checklist: ${record.index}`);
    }
    const checklistIds = new Set();
    for (const item of record.checklist) {
      const itemId = String(item?.id ?? "");
      if (!itemId) throw new Error(`Checklist item has no id: ${record.index}`);
      if (checklistIds.has(itemId)) throw new Error(`Duplicate checklist id: ${record.index}/${itemId}`);
      checklistIds.add(itemId);
      if (!DIMENSIONS.includes(item.class)) {
        throw new Error(`Unknown checklist dimension: ${record.index}/${itemId}/${item.class}`);
      }
      if (typeof item.content !== "string" || !item.content.trim()) {
        throw new Error(`Checklist item has no content: ${record.index}/${itemId}`);
      }
      if (typeof item.pass !== "boolean") {
        throw new Error(`Checklist item has no boolean pass label: ${record.index}/${itemId}`);
      }
    }
  }
}

export function selectGenerationCases(records, {
  seed = GENERATION_SEED,
  perCategory = 2,
} = {}) {
  assertWebTestBenchRecords(records);
  if (!Number.isInteger(perCategory) || perCategory < 1) {
    throw new Error("perCategory must be a positive integer");
  }

  return CATEGORIES.flatMap((category) => {
    const candidates = records
      .filter((record) => record.category === category)
      // Category filtering already partitions the pool. Keeping the category
      // out of the hash input makes the selection formula small enough to
      // reproduce exactly from the published seed and application id.
      .sort(compareByRank(seed, (record) => record.index));
    if (candidates.length < perCategory) {
      throw new Error(`Not enough WebTestBench records in ${category}: ${candidates.length}`);
    }
    return candidates.slice(0, perCategory);
  });
}

function regressionCase(record, item) {
  return {
    id: `${record.index}:${item.id}`,
    appId: record.index,
    category: record.category,
    dimension: item.class,
    instruction: record.instruction,
    expectation: item.content,
    expectedOutcome: item.pass ? "Pass" : "Fail",
    ...(typeof item.bug === "string" && item.bug.trim() ? { bug: item.bug } : {}),
  };
}

export function selectRegressionCases(records, { seed = REGRESSION_SEED } = {}) {
  assertWebTestBenchRecords(records);
  const flattened = records.flatMap((record) => record.checklist.map((item) => regressionCase(record, item)));
  const selected = [];

  for (const category of CATEGORIES) {
    for (const dimension of DIMENSIONS) {
      for (const expectedOutcome of ["Pass", "Fail"]) {
        const pool = flattened
          .filter((item) => item.category === category
            && item.dimension === dimension
            && item.expectedOutcome === expectedOutcome)
          .sort(compareByRank(
            `${seed}:${category}:${dimension}:${expectedOutcome}`,
            (item) => item.id,
          ));
        if (pool.length === 0) {
          throw new Error(`No ${expectedOutcome} item for ${category}/${dimension}`);
        }
        selected.push(pool[0]);
      }
    }
  }
  // Do not expose the Pass/Fail pair construction through output position.
  // This ordering depends on case identity only, never on the hidden label.
  return selected.sort(compareByRank(`${seed}:final-order`, (item) => item.id));
}

export function parseCsv(contents) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const text = String(contents).replace(/^\uFEFF/, "");

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows.shift();
  if (headers.some((header) => !header)) throw new Error("CSV contains an empty header");
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values, rowIndex) => {
      if (values.length !== headers.length) {
        throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
      }
      return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
    });
}

export function selectHealingCases(rows, ids = HEALING_IDS) {
  if (!Array.isArray(rows)) throw new TypeError("ReproBreak rows must be an array");
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  return ids.map((locatorId) => {
    const row = byId.get(locatorId);
    if (!row) throw new Error(`Missing curated ReproBreak locator id: ${locatorId}`);
    for (const key of ["repository", "old_locator", "new_locator", "category"]) {
      if (typeof row[key] !== "string" || !row[key]) {
        throw new Error(`ReproBreak locator ${locatorId} has no ${key}`);
      }
    }
    return {
      id: `reprobreak-${locatorId}`,
      locatorId,
      repository: row.repository,
      oldLocator: row.old_locator,
      newLocator: row.new_locator,
      changeCategory: row.category,
      requiredModes: ["reproduce_break", "overwrite"],
    };
  });
}

export function generationCandidate(record) {
  return {
    id: record.index,
    category: record.category,
    instruction: record.instruction,
  };
}

export function generationReference(record) {
  return {
    ...generationCandidate(record),
    checklist: record.checklist.map((item) => ({
      id: String(item.id),
      content: item.content,
      dimension: item.class,
    })),
  };
}

export function regressionCandidate(reference) {
  const {
    expectedOutcome: _expectedOutcome,
    bug: _bug,
    category: _category,
    dimension: _dimension,
    ...candidate
  } = reference;
  return candidate;
}

export function healingCandidate(reference) {
  const { newLocator: _newLocator, ...candidate } = reference;
  return candidate;
}

export function assertCandidateSafe(value, path = "candidate") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCandidateSafe(item, `${path}[${index}]`));
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CANDIDATE_KEYS.has(key)) {
      throw new Error(`Candidate view leaks hidden field ${path}.${key}`);
    }
    assertCandidateSafe(child, `${path}.${key}`);
  }
  return value;
}

export function createPreparedTrack(webTestBenchRecords, reproBreakRows) {
  const generationRecords = selectGenerationCases(webTestBenchRecords);
  const regressionReferences = selectRegressionCases(webTestBenchRecords);
  const healingReferences = selectHealingCases(reproBreakRows);
  const candidates = {
    generation: generationRecords.map(generationCandidate),
    regression: regressionReferences.map(regressionCandidate),
    healing: healingReferences.map(healingCandidate),
  };
  assertCandidateSafe(candidates);
  return {
    candidates,
    references: {
      generation: generationRecords.map(generationReference),
      regression: regressionReferences,
      healing: healingReferences,
    },
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1(precision, recall) {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function requiredGeneratedField(item, field, taskId) {
  const value = item?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Generation prediction ${taskId} contains a test without ${field}`);
  }
  return value.trim();
}

export function generationPredictionDigest(item) {
  return sha256(JSON.stringify({
    class: item.class,
    description: item.description,
    action: item.action,
    expected: item.expected,
  }));
}

export function generationReferenceDigest(item) {
  return sha256(JSON.stringify({
    dimension: item.dimension,
    content: item.content,
  }));
}

export function regressionCandidateDigest(item) {
  return sha256(JSON.stringify(item));
}

function normalizePredictionItems(prediction) {
  if (!Array.isArray(prediction?.tests)) throw new Error(`Generation prediction ${prediction?.taskId ?? "?"} has no tests array`);
  const items = prediction.tests.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Generation prediction ${prediction.taskId} contains a non-object test`);
    }
    const id = String(item.id ?? "");
    if (!id || id === "undefined" || id === "null") {
      throw new Error(`Generation prediction ${prediction.taskId} contains a test without an id`);
    }
    const testClass = requiredGeneratedField(item, "class", prediction.taskId).toLowerCase();
    if (!DIMENSIONS.includes(testClass)) {
      throw new Error(`Generation prediction ${prediction.taskId}/${id} has an unknown QA class`);
    }
    return {
      id,
      class: testClass,
      description: requiredGeneratedField(item, "description", prediction.taskId),
      action: requiredGeneratedField(item, "action", prediction.taskId),
      expected: requiredGeneratedField(item, "expected", prediction.taskId),
    };
  });
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate generated test id for ${prediction.taskId}`);
  const contentDigests = items.map(generationPredictionDigest);
  if (new Set(contentDigests).size !== contentDigests.length) {
    throw new Error(`Generation prediction ${prediction.taskId} repeats identical test content under different ids`);
  }
  return items;
}

export function scoreGeneration({ referenceCases, predictions = [], mappings = [] }) {
  if (!Array.isArray(referenceCases) || !Array.isArray(predictions) || !Array.isArray(mappings)) {
    throw new TypeError("Generation referenceCases, predictions, and mappings must be arrays");
  }
  const references = new Map(referenceCases.map((item) => [item.id, item]));
  if (references.size !== referenceCases.length) throw new Error("Duplicate generation reference id");
  const predictionMap = new Map();
  const predictedItems = new Map();
  let predictedCount = 0;
  for (const prediction of predictions) {
    if (!references.has(prediction.taskId)) throw new Error(`Unknown generation task: ${prediction.taskId}`);
    if (predictionMap.has(prediction.taskId)) throw new Error(`Duplicate generation prediction: ${prediction.taskId}`);
    const items = normalizePredictionItems(prediction);
    predictionMap.set(prediction.taskId, items);
    predictedCount += items.length;
    items.forEach((item) => predictedItems.set(`${prediction.taskId}\0${item.id}`, item));
  }

  const judgedPredictions = new Set();
  const matchedPredictions = new Set();
  const matchedReferences = new Set();
  for (const mapping of mappings) {
    const taskId = String(mapping?.taskId ?? "");
    const candidateId = String(mapping?.candidateId ?? "");
    const candidateKey = `${taskId}\0${candidateId}`;
    const predictedItem = predictedItems.get(candidateKey);
    if (!predictedItem) throw new Error(`Mapping names an unknown generated test: ${taskId}/${candidateId}`);
    if (judgedPredictions.has(candidateKey)) throw new Error(`Generated test was judged more than once: ${taskId}/${candidateId}`);
    if (typeof mapping.judge !== "string" || !mapping.judge.trim()
      || typeof mapping.rationale !== "string" || !mapping.rationale.trim()) {
      throw new Error(`Mapping needs an identified judge and rationale: ${taskId}/${candidateId}`);
    }
    const expectedCandidateDigest = generationPredictionDigest(predictedItem);
    if (mapping.candidateSha256 !== expectedCandidateDigest) {
      throw new Error(`Mapping is not bound to the generated test text: ${taskId}/${candidateId}`);
    }
    judgedPredictions.add(candidateKey);
    if (mapping.matched === false && mapping.referenceId !== null && mapping.referenceId !== undefined) {
      throw new Error(`Mapping has contradictory matched/reference fields: ${taskId}/${candidateId}`);
    }
    if (mapping.referenceId === null || mapping.referenceId === undefined || mapping.matched === false) {
      if (mapping.referenceSha256 !== null && mapping.referenceSha256 !== undefined) {
        throw new Error(`Unmatched mapping must not bind a gold test: ${taskId}/${candidateId}`);
      }
      continue;
    }

    const referenceId = String(mapping.referenceId);
    const reference = references.get(taskId);
    const referenceItem = (reference?.checklist ?? []).find((item) => String(item.id) === referenceId);
    if (!referenceItem) {
      throw new Error(`Mapping names an unknown gold test: ${taskId}/${referenceId}`);
    }
    if (mapping.referenceSha256 !== generationReferenceDigest(referenceItem)) {
      throw new Error(`Mapping is not bound to the gold test text: ${taskId}/${referenceId}`);
    }
    const referenceKey = `${taskId}\0${referenceId}`;
    matchedPredictions.add(candidateKey);
    matchedReferences.add(referenceKey);
  }

  const goldCount = referenceCases.reduce((sum, task) => sum + (task.checklist?.length ?? 0), 0);
  const precision = ratio(matchedPredictions.size, predictedCount);
  const recall = ratio(matchedReferences.size, goldCount);
  const coverageByTask = referenceCases.map((task) => {
    const gold = task.checklist?.length ?? 0;
    const matched = [...matchedReferences].filter((key) => key.startsWith(`${task.id}\0`)).length;
    return ratio(matched, gold);
  });
  const coverage = ratio(coverageByTask.reduce((sum, value) => sum + value, 0), referenceCases.length);

  return {
    tasks: referenceCases.length,
    submittedTasks: predictionMap.size,
    predicted: predictedCount,
    gold: goldCount,
    matched: matchedPredictions.size,
    coveredGold: matchedReferences.size,
    judgedPredictions: judgedPredictions.size,
    judgmentCoverage: ratio(judgedPredictions.size, predictedCount),
    precision,
    recall,
    f1: f1(precision, recall),
    coverage,
  };
}

function normalizeRegressionOutcome(value) {
  const normalized = String(value ?? "blocked").trim().toLowerCase();
  if (normalized === "pass") return "Pass";
  if (normalized === "fail") return "Fail";
  if (normalized === "blocked") return "blocked";
  throw new Error(`Regression outcome must be Pass, Fail, or blocked; received ${value}`);
}

export function scoreRegression({ referenceCases, predictions = [] }) {
  if (!Array.isArray(referenceCases) || !Array.isArray(predictions)) {
    throw new TypeError("Regression referenceCases and predictions must be arrays");
  }
  const predictionMap = new Map();
  const validIds = new Set(referenceCases.map((item) => item.id));
  for (const prediction of predictions) {
    if (!validIds.has(prediction.caseId)) throw new Error(`Unknown regression case: ${prediction.caseId}`);
    if (predictionMap.has(prediction.caseId)) throw new Error(`Duplicate regression prediction: ${prediction.caseId}`);
    predictionMap.set(prediction.caseId, normalizeRegressionOutcome(prediction.outcome));
  }

  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let abstainedPositive = 0;
  let abstainedNegative = 0;

  for (const item of referenceCases) {
    const expected = item.expectedOutcome;
    if (expected !== "Pass" && expected !== "Fail") throw new Error(`Invalid regression reference outcome: ${item.id}`);
    const predicted = predictionMap.get(item.id) ?? "blocked";
    if (expected === "Fail") {
      if (predicted === "Fail") truePositive += 1;
      else {
        falseNegative += 1;
        if (predicted === "blocked") abstainedPositive += 1;
      }
    } else if (predicted === "Pass") {
      trueNegative += 1;
    } else if (predicted === "Fail") {
      falsePositive += 1;
    } else {
      abstainedNegative += 1;
    }
  }

  const total = referenceCases.length;
  const actualPositive = truePositive + falseNegative;
  const actualNegative = trueNegative + falsePositive + abstainedNegative;
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, actualPositive);
  const specificity = ratio(trueNegative, actualNegative);
  const answered = total - abstainedPositive - abstainedNegative;
  return {
    total,
    answered,
    correct: truePositive + trueNegative,
    incorrect: total - truePositive - trueNegative,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    abstainedPositive,
    abstainedNegative,
    precision,
    recall,
    f1: f1(precision, recall),
    specificity,
    balancedAccuracy: (recall + specificity) / 2,
    accuracy: ratio(truePositive + trueNegative, total),
    coverage: ratio(answered, total),
  };
}

function hasEvidence(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(hasEvidence);
  return false;
}

export function healingEvidenceComplete(prediction) {
  const evidence = prediction?.evidence;
  return Boolean(evidence
    && hasEvidence(evidence.before)
    && hasEvidence(evidence.after)
    && hasEvidence(evidence.failedTarget)
    && hasEvidence(evidence.replacement)
    && hasEvidence(evidence.strategy)
    && hasEvidence(evidence.retryOutcome)
    && hasEvidence(evidence.verification));
}

function healingEvidenceConsistent(prediction, expectedOutcome) {
  if (!healingEvidenceComplete(prediction)) return false;
  const evidence = prediction.evidence;
  const failedTarget = evidence.failedTarget.trim();
  const replacement = evidence.replacement.trim();
  const retryOutcome = evidence.retryOutcome.trim().toLowerCase();
  if (failedTarget === replacement) return false;
  if (expectedOutcome === "healed") return new Set(["healed", "passed"]).has(retryOutcome);
  return new Set(["functional_regression", "failed"]).has(retryOutcome);
}

export function geometricMean(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("geometricMean needs at least one value");
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("geometricMean values must be finite numbers from 0 to 1");
  }
  if (values.some((value) => value === 0)) return 0;
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

export function scoreHealing({ referenceCases, predictions = [] }) {
  if (!Array.isArray(referenceCases) || !Array.isArray(predictions)) {
    throw new TypeError("Healing referenceCases and predictions must be arrays");
  }
  const validIds = new Set(referenceCases.map((item) => item.id));
  const predictionMap = new Map();
  for (const prediction of predictions) {
    if (!validIds.has(prediction.caseId)) throw new Error(`Unknown healing case: ${prediction.caseId}`);
    if (predictionMap.has(prediction.caseId)) throw new Error(`Duplicate healing prediction: ${prediction.caseId}`);
    predictionMap.set(prediction.caseId, prediction);
  }

  let claimedHeals = 0;
  let safeHeals = 0;
  let invalidHealClaims = 0;
  let controlSubmitted = 0;
  let falseHeals = 0;
  let correctRegressions = 0;
  let unchangedCount = 0;
  let completeEvidenceCount = 0;
  let consistentEvidenceCount = 0;
  let equivalenceCount = 0;
  let reproducedCount = 0;

  for (const item of referenceCases) {
    const prediction = predictionMap.get(item.id);
    if (!prediction) continue;
    if (!["healed", "functional_regression", "blocked"].includes(prediction.outcome)) {
      throw new Error(`Invalid healing outcome for ${item.id}: ${prediction.outcome}`);
    }
    const claimed = prediction.outcome === "healed";
    const expectationsUnchanged = prediction.expectationsUnchanged === true;
    const evidenceComplete = healingEvidenceComplete(prediction)
      && prediction.beforeEvidenceExists === true && prediction.afterEvidenceExists === true;
    const evidenceConsistent = healingEvidenceConsistent(prediction, "healed");
    const equivalenceVerified = prediction.equivalenceVerified === true;
    const breakReproduced = prediction.breakReproduced === true;
    const retryPassed = prediction.retryPassed === true;
    const oneRetry = prediction.actionAttempts === 1
      && prediction.retryCount === 1 && prediction.recoveryAttempts === 1;
    if (claimed) claimedHeals += 1;
    const expectationsFrozen = prediction.expectationsFrozen === true;
    if (expectationsUnchanged && expectationsFrozen) unchangedCount += 1;
    if (evidenceComplete) completeEvidenceCount += 1;
    if (evidenceConsistent) consistentEvidenceCount += 1;
    if (equivalenceVerified) equivalenceCount += 1;
    if (breakReproduced) reproducedCount += 1;
    if (claimed && breakReproduced && retryPassed && oneRetry
      && equivalenceVerified && expectationsUnchanged && expectationsFrozen && evidenceConsistent) {
      safeHeals += 1;
    } else if (claimed) {
      invalidHealClaims += 1;
    }

    const control = prediction.regressionControl;
    if (!control || typeof control !== "object") continue;
    controlSubmitted += 1;
    if (!["healed", "functional_regression", "blocked"].includes(control.outcome)) {
      throw new Error(`Invalid regression-control outcome for ${item.id}: ${control.outcome}`);
    }
    const controlUnchanged = control.expectationsUnchanged === true;
    const controlEvidenceComplete = healingEvidenceComplete(control)
      && control.beforeEvidenceExists === true && control.afterEvidenceExists === true;
    const controlEvidenceConsistent = healingEvidenceConsistent(control, "functional_regression");
    const controlEquivalent = control.equivalenceVerified === true;
    const controlReproduced = control.breakReproduced === true;
    const controlOneRetry = control.actionAttempts === 1
      && control.retryCount === 1 && control.recoveryAttempts === 1;
    const controlRetryFailed = control.retryPassed === false;
    const controlExpectationsFrozen = control.expectationsFrozen === true;
    if (controlUnchanged && controlExpectationsFrozen) unchangedCount += 1;
    if (controlEvidenceComplete) completeEvidenceCount += 1;
    if (controlEvidenceConsistent) consistentEvidenceCount += 1;
    if (controlEquivalent) equivalenceCount += 1;
    if (controlReproduced) reproducedCount += 1;
    if (control.outcome === "healed") falseHeals += 1;
    if (control.outcome === "functional_regression" && controlReproduced
      && controlOneRetry && controlRetryFailed && controlEquivalent
      && controlUnchanged && controlExpectationsFrozen && controlEvidenceConsistent) {
      correctRegressions += 1;
    }
  }

  const total = referenceCases.length;
  const totalScenarios = total * 2;
  const healRecall = ratio(safeHeals, total);
  const falseHealRate = ratio(falseHeals, total);
  const invalidHealClaimRate = ratio(invalidHealClaims, claimedHeals);
  const trueRegressionDetection = ratio(correctRegressions, total);
  const controlCoverage = ratio(controlSubmitted, total);
  const unchangedExpectations = ratio(unchangedCount, totalScenarios);
  const evidenceCompleteness = ratio(completeEvidenceCount, totalScenarios);
  const evidenceConsistency = ratio(consistentEvidenceCount, totalScenarios);
  const equivalenceVerification = ratio(equivalenceCount, totalScenarios);
  const breakReproduction = ratio(reproducedCount, totalScenarios);
  const safetyScore = geometricMean([
    healRecall,
    1 - falseHealRate,
    1 - invalidHealClaimRate,
    trueRegressionDetection,
    unchangedExpectations,
    evidenceCompleteness,
    evidenceConsistency,
    equivalenceVerification,
    breakReproduction,
  ]);
  return {
    total,
    submitted: predictionMap.size,
    controlSubmitted,
    claimedHeals,
    safeHeals,
    invalidHealClaims,
    falseHeals,
    correctRegressions,
    healRecall,
    claimPrecision: ratio(safeHeals, claimedHeals),
    invalidHealClaimRate,
    falseHealRate,
    trueRegressionDetection,
    controlCoverage,
    unchangedExpectations,
    evidenceCompleteness,
    evidenceConsistency,
    equivalenceVerification,
    breakReproduction,
    safetyScore,
  };
}

export function scoreComposite({ generation, regression, healing }) {
  for (const [name, metrics] of Object.entries({ generation, regression, healing })) {
    if (!metrics || typeof metrics !== "object") throw new Error(`Missing ${name} metrics`);
  }
  const laneScores = {
    generation: generation.f1,
    regression: geometricMean([regression.f1, regression.specificity]),
    healing: healing.safetyScore,
  };
  const gates = [
    {
      id: "all-generated-tests-judged",
      passed: generation.judgmentCoverage === 1,
      value: generation.judgmentCoverage,
      required: 1,
    },
    {
      id: "no-regression-abstentions",
      passed: regression.coverage === 1,
      value: regression.coverage,
      required: 1,
    },
    {
      id: "no-false-heals",
      passed: healing.falseHealRate === 0,
      value: healing.falseHealRate,
      required: 0,
    },
    {
      id: "no-invalid-heal-claims",
      passed: healing.invalidHealClaims === 0,
      value: healing.invalidHealClaims,
      required: 0,
    },
    {
      id: "all-healing-controls-submitted",
      passed: healing.controlCoverage === 1,
      value: healing.controlCoverage,
      required: 1,
    },
    {
      id: "all-true-regressions-protected",
      passed: healing.trueRegressionDetection === 1,
      value: healing.trueRegressionDetection,
      required: 1,
    },
    {
      id: "expectations-unchanged",
      passed: healing.unchangedExpectations === 1,
      value: healing.unchangedExpectations,
      required: 1,
    },
    {
      id: "complete-healing-evidence",
      passed: healing.evidenceCompleteness === 1,
      value: healing.evidenceCompleteness,
      required: 1,
    },
    {
      id: "consistent-healing-evidence",
      passed: healing.evidenceConsistency === 1,
      value: healing.evidenceConsistency,
      required: 1,
    },
  ];
  const rawScore = geometricMean(Object.values(laneScores));
  const eligible = gates.every((gate) => gate.passed);
  return {
    eligible,
    score: eligible ? rawScore : 0,
    rawScore,
    laneScores,
    gates,
  };
}
