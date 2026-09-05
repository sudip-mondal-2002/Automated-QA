import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRACK_ID,
  assertCandidateSafe,
  regressionCandidateDigest,
  scoreComposite,
  scoreGeneration,
  scoreHealing,
  scoreRegression,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const INPUT_FILES = Object.freeze([
  "run.json",
  "generation.json",
  "generation-mappings.json",
  "regression.json",
  "healing.json",
]);

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function normalizeGeneration(value) {
  if (!Array.isArray(value)) throw new Error("generation.json must contain an array");
  return value.map((entry) => ({
    taskId: String(entry.taskId ?? entry.index ?? ""),
    tests: entry.tests ?? entry.items,
  }));
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactInventory(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (!valuesEqual(left, right) || new Set(actual).size !== actual.length) {
    throw new Error(`${label} inventory does not exactly match the prepared track`);
  }
}

function evidencePaths(value) {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(evidencePaths);
  return [];
}

function safeEvidencePath(runDirectory, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error(`Evidence path must be a non-empty relative path: ${relativePath}`);
  }
  const resolved = path.resolve(runDirectory, relativePath);
  const root = `${path.resolve(runDirectory)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error(`Evidence path leaves the run directory: ${relativePath}`);
  return resolved;
}

function imageEvidenceKind(contents) {
  if (contents.length >= 33
    && contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && contents.subarray(12, 16).toString("ascii") === "IHDR"
    && contents.readUInt32BE(16) > 0
    && contents.readUInt32BE(20) > 0
    && contents.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))) return "png";
  if (contents.length >= 128
    && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff
    && contents.at(-2) === 0xff && contents.at(-1) === 0xd9) return "jpeg";
  if (contents.length >= 30
    && contents.subarray(0, 4).toString("ascii") === "RIFF"
    && contents.subarray(8, 12).toString("ascii") === "WEBP"
    && contents.readUInt32LE(4) + 8 === contents.length) return "webp";
  return null;
}

function healingExecutionRecord({ relativePath, contents, details, digest }) {
  let record;
  try {
    record = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`Healing execution record is not valid JSON: ${relativePath}`);
  }
  const { caseId, value, before, after, expectedExpectation, sourceCase } = details;
  const declared = value.evidence?.execution;
  if (!declared || declared.sha256 !== digest) {
    throw new Error(`Healing execution digest does not match its submission: ${relativePath}`);
  }
  const pathRunId = path.posix.basename(path.posix.dirname(relativePath));
  if (record.version !== 1 || record.runId !== pathRunId || record.specId !== caseId
    || record.environment !== "local" || record.classification !== value.outcome) {
    throw new Error(`Healing execution record does not match ${caseId}: ${relativePath}`);
  }
  if (declared.classification !== record.classification) {
    throw new Error(`Healing execution classification binding is inconsistent: ${relativePath}`);
  }
  const step = record.steps?.[0];
  const healing = step?.healing;
  const expectedHealingOutcome = record.classification === "healed"
    ? "healed"
    : record.classification === "functional_regression"
      ? "failed"
      : record.classification === "blocked" ? "blocked" : undefined;
  const expectedStepStatus = record.classification === "healed"
    ? "passed"
    : record.classification === "blocked" ? "blocked" : "failed";
  if (record.steps?.length !== 1 || step?.index !== 1 || step.intent !== sourceCase?.semanticIntent
    || !healing || healing.strategy !== "target_rediscovery" || !expectedHealingOutcome
    || declared.healingOutcome !== expectedHealingOutcome || healing.outcome !== expectedHealingOutcome
    || step.status !== expectedStepStatus) {
    throw new Error(`Healing execution record has no matching recovery event: ${relativePath}`);
  }
  const recordedExpectations = step.expectations ?? [];
  if (typeof expectedExpectation !== "string" || recordedExpectations.length !== 1
    || recordedExpectations[0]?.expectation !== expectedExpectation) {
    throw new Error(`Healing execution record does not preserve the frozen expectation: ${relativePath}`);
  }
  const expectedExpectationStatus = record.classification === "healed"
    ? "passed"
    : record.classification === "blocked" ? "blocked" : "failed";
  if (recordedExpectations[0].status !== expectedExpectationStatus) {
    throw new Error(`Healing execution expectation status contradicts its classification: ${relativePath}`);
  }
  const replacement = value.evidence?.replacement;
  if (healing.replacement !== replacement
    || step.selectedTarget?.summary !== replacement
    || typeof healing.originalFailure !== "string"
    || !healing.originalFailure.includes(value.evidence?.failedTarget ?? "")
    || typeof healing.verification !== "string" || !healing.verification.trim()) {
    throw new Error(`Healing execution recovery binding is inconsistent: ${relativePath}`);
  }
  const resultDirectory = path.posix.dirname(relativePath);
  const boundBefore = path.posix.normalize(path.posix.join(resultDirectory, healing.beforeScreenshot ?? ""));
  const boundAfter = path.posix.normalize(path.posix.join(resultDirectory, healing.afterScreenshot ?? ""));
  if (!before.includes(boundBefore) || !after.includes(boundAfter)) {
    throw new Error(`Healing execution record does not bind its before/after evidence: ${relativePath}`);
  }
  const screenshots = record.evidence?.screenshots ?? [];
  if (!Array.isArray(screenshots) || !screenshots.includes(healing.beforeScreenshot)
    || !screenshots.includes(healing.afterScreenshot)) {
    throw new Error(`Healing execution record does not inventory its screenshots: ${relativePath}`);
  }
  const eventTypes = record.events?.map((event) => event.type) ?? [];
  if (eventTypes.filter((type) => type === "healing_started").length !== 1
    || eventTypes.filter((type) => type === "healing_completed").length !== 1) {
    throw new Error(`Healing execution record must contain exactly one recovery lifecycle: ${relativePath}`);
  }
  const started = record.events.findIndex((event) => event.type === "healing_started");
  const completed = record.events.findIndex((event) => event.type === "healing_completed");
  const startEvent = record.events[started];
  const completion = record.events.find((event) => event.type === "healing_completed");
  if (started >= completed || startEvent.stepIndex !== 1 || completion.stepIndex !== 1
    || completion.status !== expectedStepStatus) {
    throw new Error(`Healing completion status contradicts its classification: ${relativePath}`);
  }
  const expectationStatuses = step.expectations?.map((expectation) => expectation.status) ?? [];
  if (value.retryPassed === true && (record.classification !== "healed" || expectationStatuses.some((status) => status !== "passed"))) {
    throw new Error(`Healing execution record contradicts a successful retry claim: ${relativePath}`);
  }
  if (value.retryPassed === false && record.classification === "healed") {
    throw new Error(`Healing execution record contradicts a failed retry claim: ${relativePath}`);
  }
}

function regressionExecutionRecord({ relativePath, contents, details, digest }) {
  let record;
  try {
    record = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`Regression execution trace is not valid JSON: ${relativePath}`);
  }
  const { prediction, candidate, archive, runnerAssignment } = details;
  const declared = prediction.execution;
  const candidateDigest = regressionCandidateDigest(candidate);
  if (!declared || declared.sha256 !== digest || declared.trace !== relativePath) {
    throw new Error(`Regression execution trace digest does not match its submission: ${relativePath}`);
  }
  if (record.schemaVersion !== 1 || record.caseId !== prediction.caseId || record.appId !== candidate.appId
    || record.candidateSha256 !== candidateDigest || record.appArchiveSha256 !== archive.sha256
    || record.outcome !== prediction.outcome || record.notes !== prediction.notes
    || record.confidence !== prediction.confidence || !new Set(["high", "medium", "low"]).has(record.confidence)
    || !runnerAssignment || record.laneId !== runnerAssignment.laneId
    || record.runner !== runnerAssignment.runner) {
    throw new Error(`Regression execution trace does not match ${prediction.caseId}: ${relativePath}`);
  }
  const browserRecorded = typeof record.browser === "string"
    ? Boolean(record.browser.trim())
    : record.browser && typeof record.browser.name === "string" && Boolean(record.browser.name.trim())
      && typeof record.browser.version === "string" && Boolean(record.browser.version.trim());
  const auditEntry = (item) => typeof item === "string"
    ? Boolean(item.trim())
    : item && typeof item === "object" && Object.values(item).some((value) => typeof value === "string" && value.trim());
  if (typeof record.runner !== "string" || !record.runner.trim()
    || !browserRecorded
    || typeof record.isolation !== "string" || !record.isolation.trim()
    || !Array.isArray(record.actions) || record.actions.length === 0
    || !record.actions.every(auditEntry)
    || !Array.isArray(record.observations) || record.observations.length === 0
    || !record.observations.every(auditEntry)
    || typeof record.notes !== "string" || !record.notes.trim()) {
    throw new Error(`Regression execution trace is missing its audit narrative: ${relativePath}`);
  }
  const startedAt = Date.parse(record.startedAt);
  const completedAt = Date.parse(record.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(`Regression execution trace has invalid timestamps: ${relativePath}`);
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    throw new Error(`Regression execution trace has no bound evidence: ${relativePath}`);
  }
  return record;
}

export async function inventoryEvidence(runDirectory, regression, healing, options = {}) {
  const requested = new Map();
  const healingPairs = [];
  const regressionTraces = [];
  const request = (relativePath, owner, kind, ownerGroup = owner, details) => {
    const existing = requested.get(relativePath);
    if (existing) throw new Error(`Evidence file is reused across requirements: ${relativePath}`);
    requested.set(relativePath, { owner, ownerGroup, kind, details });
  };
  for (const prediction of regression) {
    const paths = evidencePaths(prediction.evidence);
    if (paths.length === 0) throw new Error(`Regression case ${prediction.caseId} has no evidence artifact`);
    if (new Set(paths).size !== paths.length) throw new Error(`Regression case ${prediction.caseId} repeats an evidence artifact`);
    paths.forEach((item) => request(item, `regression:${prediction.caseId}`, "regression"));
    const candidate = options.regressionCandidates?.[prediction.caseId];
    const archive = candidate ? options.appArchives?.[candidate.appId] : undefined;
    if (!candidate || !archive || typeof prediction.execution?.trace !== "string"
      || !/^[a-f0-9]{64}$/.test(prediction.execution?.sha256 ?? "")) {
      throw new Error(`Regression case ${prediction.caseId} needs a candidate- and archive-bound execution trace`);
    }
    request(prediction.execution.trace, `regression:${prediction.caseId}`, "regression-execution", undefined, {
      prediction,
      candidate,
      archive,
      runnerAssignment: options.regressionAssignments?.[prediction.caseId],
    });
  }
  for (const prediction of healing) {
    for (const [scenario, value] of [["drift", prediction], ["regression-control", prediction.regressionControl]]) {
      if (!value || typeof value !== "object") {
        throw new Error(`Healing case ${prediction.caseId} has no ${scenario} result`);
      }
      const before = evidencePaths(value.evidence?.before);
      const after = evidencePaths(value.evidence?.after);
      if (before.length === 0 || after.length === 0) {
        throw new Error(`Healing case ${prediction.caseId}/${scenario} needs before and after evidence`);
      }
      if (new Set([...before, ...after]).size !== before.length + after.length) {
        throw new Error(`Healing case ${prediction.caseId}/${scenario} reuses before/after evidence`);
      }
      const owner = `healing:${prediction.caseId}:${scenario}`;
      const ownerGroup = `healing:${prediction.caseId}`;
      before.forEach((item) => request(item, owner, "healing-image", ownerGroup));
      after.forEach((item) => request(item, owner, "healing-image", ownerGroup));
      const execution = value.evidence?.execution;
      if (!execution || typeof execution.result !== "string" || !/^[a-f0-9]{64}$/.test(execution.sha256 ?? "")) {
        throw new Error(`Healing case ${prediction.caseId}/${scenario} needs a hash-bound native execution record`);
      }
      request(execution.result, owner, "healing-execution", ownerGroup, {
        caseId: prediction.caseId,
        value,
        before,
        after,
        expectedExpectation: options.healingExpectations?.[prediction.caseId],
        sourceCase: options.healingCases?.[prediction.caseId],
      });
      healingPairs.push({ owner, before, after });
    }
  }

  const inventory = [];
  const digestByPath = new Map();
  const ownerByDigest = new Map();
  const realRoot = `${await realpath(runDirectory)}${path.sep}`;
  for (const [relativePath, requirement] of [...requested].sort(([left], [right]) => left.localeCompare(right))) {
    const absolute = safeEvidencePath(runDirectory, relativePath);
    const linkMetadata = await lstat(absolute);
    if (linkMetadata.isSymbolicLink()) throw new Error(`Evidence must not be a symbolic link: ${relativePath}`);
    const realFile = await realpath(absolute);
    if (!realFile.startsWith(realRoot)) throw new Error(`Evidence resolves outside the run directory: ${relativePath}`);
    const metadata = await stat(absolute);
    if (!metadata.isFile() || metadata.size === 0) throw new Error(`Evidence is missing or empty: ${relativePath}`);
    const contents = await readFile(absolute);
    const imageKind = imageEvidenceKind(contents);
    const semanticText = /\.(?:html?|md|txt)$/i.test(relativePath)
      && !contents.includes(0)
      && contents.toString("utf8").trim().length >= 64;
    if (requirement.kind === "healing-image" && !imageKind) {
      throw new Error(`Healing evidence must have a recognized PNG, JPEG, or WebP container signature: ${relativePath}`);
    }
    if (requirement.kind === "regression" && !imageKind && !semanticText) {
      throw new Error(`Regression evidence must be an image or semantic text snapshot: ${relativePath}`);
    }
    const digest = sha256(contents);
    if (requirement.kind === "healing-execution") {
      healingExecutionRecord({ relativePath, contents, details: requirement.details, digest });
    }
    if (requirement.kind === "regression-execution") {
      regressionTraces.push({
        relativePath,
        prediction: requirement.details.prediction,
        record: regressionExecutionRecord({ relativePath, contents, details: requirement.details, digest }),
      });
    }
    const existingOwner = ownerByDigest.get(digest);
    if (existingOwner && existingOwner !== requirement.ownerGroup) {
      throw new Error(`Evidence bytes are reused across cases: ${relativePath}`);
    }
    ownerByDigest.set(digest, requirement.ownerGroup);
    digestByPath.set(relativePath, digest);
    inventory.push({
      file: relativePath,
      owner: requirement.owner,
      kind: requirement.kind.endsWith("-execution") ? "execution-json" : imageKind ?? "semantic-text",
      bytes: contents.length,
      sha256: digest,
    });
  }
  for (const pair of healingPairs) {
    const before = new Set(pair.before.map((item) => digestByPath.get(item)));
    const after = new Set(pair.after.map((item) => digestByPath.get(item)));
    if (before.size === after.size && [...before].every((digest) => after.has(digest))) {
      throw new Error(`Healing before/after evidence is byte-identical: ${pair.owner}`);
    }
  }
  const inventoryByPath = new Map(inventory.map((item) => [item.file, item]));
  for (const { relativePath, prediction, record } of regressionTraces) {
    const submittedPaths = evidencePaths(prediction.evidence);
    const tracedPaths = record.evidence.map((item) => item?.file);
    exactInventory(tracedPaths, submittedPaths, `Regression execution evidence ${prediction.caseId}`);
    for (const item of record.evidence) {
      const inventoried = inventoryByPath.get(item.file);
      if (!inventoried || item.sha256 !== inventoried.sha256 || item.bytes !== inventoried.bytes) {
        throw new Error(`Regression execution trace evidence digest is inconsistent: ${relativePath}`);
      }
    }
  }
  return inventory;
}

async function containedRunFile(runDirectory, relativePath, label) {
  const absolute = safeEvidencePath(runDirectory, relativePath);
  const linkMetadata = await lstat(absolute);
  if (linkMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${relativePath}`);
  const realRoot = `${await realpath(runDirectory)}${path.sep}`;
  const realFile = await realpath(absolute);
  if (!realFile.startsWith(realRoot)) throw new Error(`${label} resolves outside the run directory: ${relativePath}`);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`${label} is missing or empty: ${relativePath}`);
  return readFile(absolute);
}

function runnerMetric(correct, total) {
  return { correct, total, rate: total === 0 ? 0 : correct / total };
}

function runnerFalseRate(count, total) {
  return { count, total, rate: total === 0 ? 0 : count / total };
}

function healingRunnerScenarioPassed(scenario) {
  const expectedClassification = scenario.variant === "drift" ? "healed" : "functional_regression";
  const expectedHealingOutcome = scenario.variant === "drift" ? "healed" : "failed";
  return scenario.expectedClassification === expectedClassification
    && scenario.actualClassification === expectedClassification
    && scenario.healingOutcome === expectedHealingOutcome
    && scenario.productOutcomePassed === (scenario.actualClassification === "healed")
    && scenario.actionAttempts === 1
    && scenario.rediscoveryAttempts === 1
    && scenario.recoveryAttempts === 1
    && scenario.staleLocatorFailed === true
    && scenario.expectationsFrozen === true
    && scenario.expectationsUnchanged === true
    && scenario.equivalenceVerified === true
    && typeof scenario.semanticAudit === "string"
    && scenario.semanticAudit.length > 0
    && scenario.beforeEvidenceExists === true
    && scenario.afterEvidenceExists === true;
}

export function summarizeHealingRunnerScenarios(scenarios) {
  if (!Array.isArray(scenarios)) throw new TypeError("Healing runner scenarios must be an array");
  const drift = scenarios.filter((scenario) => scenario.variant === "drift");
  const controls = scenarios.filter((scenario) => scenario.variant === "regression");
  const validHeals = drift.filter(healingRunnerScenarioPassed).length;
  const falseHeals = controls.filter((scenario) => scenario.actualClassification === "healed" || scenario.healingOutcome === "healed").length;
  const correctRegressions = controls.filter(healingRunnerScenarioPassed).length;
  const oneRetry = scenarios.filter((scenario) => scenario.actionAttempts === 1
    && scenario.rediscoveryAttempts === 1 && scenario.recoveryAttempts === 1).length;
  const evidenceComplete = scenarios.filter((scenario) => scenario.beforeEvidenceExists === true
    && scenario.afterEvidenceExists === true).length;
  const unchanged = scenarios.filter((scenario) => scenario.expectationsUnchanged === true
    && scenario.expectationsFrozen === true).length;
  const overallCorrect = scenarios.filter(healingRunnerScenarioPassed).length;
  return {
    passed: overallCorrect === scenarios.length,
    metrics: {
      validHealRate: runnerMetric(validHeals, drift.length),
      falseHealRate: runnerFalseRate(falseHeals, controls.length),
      trueRegressionDetection: runnerMetric(correctRegressions, controls.length),
      oneRetryCompliance: runnerMetric(oneRetry, scenarios.length),
      evidenceCompleteness: runnerMetric(evidenceComplete, scenarios.length),
      unchangedExpectationProtection: runnerMetric(unchanged, scenarios.length),
      overall: runnerMetric(overallCorrect, scenarios.length),
    },
  };
}

function prefixRunnerPaths(value, directory) {
  if (Array.isArray(value)) return value.map((item) => prefixRunnerPaths(item, directory));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prefixRunnerPaths(item, directory)]));
  }
  return typeof value === "string" && value.startsWith(".qa/") ? path.posix.join(directory, value) : value;
}

async function validateHealingRunner({ runDirectory, metadata, healing, referenceCases, frozenTrack }) {
  const descriptor = metadata.healingRunner;
  for (const key of ["summary", "sourceCases", "submission"]) {
    if (typeof descriptor?.[key] !== "string" || !descriptor[key].trim()) {
      throw new Error(`run.json healingRunner.${key} must name a runner artifact`);
    }
  }
  const [summaryBytes, sourceBytes, submissionBytes] = await Promise.all([
    containedRunFile(runDirectory, descriptor.summary, "Healing runner summary"),
    containedRunFile(runDirectory, descriptor.sourceCases, "Healing runner source cases"),
    containedRunFile(runDirectory, descriptor.submission, "Healing runner submission"),
  ]);
  const sourceDigest = sha256(sourceBytes);
  if (sourceDigest !== frozenTrack.lanes?.healing?.coreCasesSha256) {
    throw new Error("Healing runner source cases do not match the frozen core cases");
  }
  let summary;
  let sourceCases;
  let coreSubmission;
  try {
    summary = JSON.parse(summaryBytes.toString("utf8"));
    sourceCases = JSON.parse(sourceBytes.toString("utf8"));
    coreSubmission = JSON.parse(submissionBytes.toString("utf8"));
  } catch {
    throw new Error("Healing runner artifacts must be valid JSON");
  }
  if (summary.track !== "reprobreak-healing-core-v1" || summary.source?.evaluatedCasesSha256 !== sourceDigest) {
    throw new Error("Healing runner summary does not bind the frozen source cases");
  }
  const expectedById = Object.fromEntries((sourceCases.cases ?? []).map((item) => [`reprobreak-${item.id}`, item.expectation]));
  exactInventory(Object.keys(expectedById), referenceCases.map((item) => item.id), "Healing runner frozen expectation");
  if (Object.values(expectedById).some((expectation) => typeof expectation !== "string" || !expectation.trim())) {
    throw new Error("Healing runner source cases contain an invalid frozen expectation");
  }
  const coreDirectory = path.posix.dirname(descriptor.submission);
  if (!valuesEqual(prefixRunnerPaths(coreSubmission, coreDirectory), healing)) {
    throw new Error("healing.json does not match the native runner submission");
  }
  const expectedKeys = referenceCases.flatMap((item) => ["drift", "regression"].map((variant) => `${item.locatorId}:${variant}`));
  const actualKeys = summary.scenarios?.map((item) => `${item.caseId}:${item.variant}`) ?? [];
  exactInventory(actualKeys, expectedKeys, "Healing runner scenario");
  const sourceCaseById = new Map((sourceCases.cases ?? []).map((item) => [item.id, item]));
  const scenarioByKey = new Map(summary.scenarios.map((item) => [`${item.caseId}:${item.variant}`, item]));
  const predictionById = new Map(healing.map((item) => [item.caseId, item]));
  for (const scenario of summary.scenarios) {
    const sourceCase = sourceCaseById.get(scenario.caseId);
    const prediction = predictionById.get(`reprobreak-${scenario.caseId}`);
    const submitted = scenario.variant === "drift" ? prediction : prediction?.regressionControl;
    const control = scenarioByKey.get(`${scenario.caseId}:regression`);
    const expectedResult = path.posix.join(coreDirectory, scenario.resultArtifact ?? "");
    const expectedClassification = scenario.variant === "drift" ? "healed" : "functional_regression";
    const actualHealingOutcome = scenario.actualClassification === "healed"
      ? "healed"
      : scenario.actualClassification === "functional_regression"
        ? "failed"
        : scenario.actualClassification === "blocked" ? "blocked" : undefined;
    const controlProtected = control?.actualClassification === "functional_regression"
      && control.healingOutcome !== "healed"
      && control.passed === true;
    const submittedEquivalence = scenario.variant === "drift"
      ? scenario.equivalenceVerified === true && scenario.productOutcomePassed === true && controlProtected
      : scenario.equivalenceVerified === true;
    const resultDirectory = path.posix.dirname(expectedResult);
    const expectedBefore = path.posix.join(resultDirectory, scenario.beforeEvidence ?? "");
    const expectedAfter = path.posix.join(resultDirectory, scenario.afterEvidence ?? "");
    if (!sourceCase || !submitted || scenario.expectedClassification !== expectedClassification
      || !actualHealingOutcome || scenario.healingOutcome !== actualHealingOutcome
      || scenario.passed !== healingRunnerScenarioPassed(scenario)
      || scenario.repository !== sourceCase.source_record?.repository_name
      || scenario.oldLocator !== sourceCase.source_record?.old_locator
      || scenario.newLocator !== sourceCase.source_record?.new_locator
      || submitted.outcome !== scenario.actualClassification
      || submitted.breakReproduced !== scenario.staleLocatorFailed
      || submitted.actionAttempts !== scenario.actionAttempts
      || submitted.retryCount !== scenario.rediscoveryAttempts
      || submitted.recoveryAttempts !== scenario.recoveryAttempts
      || submitted.retryPassed !== (scenario.actualClassification === "healed" && scenario.productOutcomePassed === true)
      || submitted.equivalenceVerified !== submittedEquivalence
      || submitted.expectationsUnchanged !== scenario.expectationsUnchanged
      || submitted.expectationsFrozen !== scenario.expectationsFrozen
      || submitted.beforeEvidenceExists !== scenario.beforeEvidenceExists
      || submitted.afterEvidenceExists !== scenario.afterEvidenceExists
      || submitted.semanticAudit !== scenario.semanticAudit
      || !valuesEqual(evidencePaths(submitted.evidence?.before), [expectedBefore])
      || !valuesEqual(evidencePaths(submitted.evidence?.after), [expectedAfter])
      || submitted.evidence?.failedTarget !== scenario.oldLocator
      || submitted.evidence?.replacement !== scenario.replacementTarget
      || submitted.evidence?.retryOutcome !== scenario.actualClassification
      || submitted.evidence?.semanticAudit !== scenario.semanticAudit
      || submitted.evidence?.execution?.result !== expectedResult
      || submitted.evidence.execution.sha256 !== scenario.resultSha256
      || submitted.evidence.execution.classification !== scenario.actualClassification
      || submitted.evidence.execution.healingOutcome !== scenario.healingOutcome) {
      throw new Error(`Healing runner scenario is not bound to its submission: ${scenario.caseId}/${scenario.variant}`);
    }
  }
  const recomputed = summarizeHealingRunnerScenarios(summary.scenarios);
  if (summary.passed !== recomputed.passed || !valuesEqual(summary.metrics, recomputed.metrics)) {
    throw new Error("Healing runner summary metrics do not match its scenarios");
  }
  const artifacts = Object.fromEntries([
    ["summary", summaryBytes],
    ["sourceCases", sourceBytes],
    ["submission", submissionBytes],
  ].map(([key, contents]) => [key, {
    file: descriptor[key],
    bytes: contents.length,
    sha256: sha256(contents),
  }]));
  return {
    artifacts,
    expectations: expectedById,
    cases: Object.fromEntries((sourceCases.cases ?? []).map((item) => [`reprobreak-${item.id}`, item])),
  };
}

async function verifiedPreparedFile(cacheDirectory, manifest, frozenTrack, kind, lane) {
  const relativePath = `${kind}/${lane}.json`;
  const contents = await readFile(path.resolve(cacheDirectory, relativePath));
  const actual = { bytes: contents.length, sha256: sha256(contents) };
  const declared = manifest.files?.[relativePath];
  if (!declared || declared.bytes !== actual.bytes || declared.sha256 !== actual.sha256) {
    throw new Error(`Prepared ${relativePath} does not match manifest.json`);
  }
  if (frozenTrack.lanes?.[lane]?.[`${kind}Sha256`] !== actual.sha256) {
    throw new Error(`Prepared ${relativePath} does not match the checked-in frozen track`);
  }
  return JSON.parse(contents.toString("utf8"));
}

function groupRegression(referenceCases, predictions, field) {
  const predictionById = new Map(predictions.map((item) => [item.caseId, item]));
  const groups = [...new Set(referenceCases.map((item) => item[field]))].sort();
  return Object.fromEntries(groups.map((group) => {
    const references = referenceCases.filter((item) => item[field] === group);
    const ids = new Set(references.map((item) => item.id));
    const submitted = [...predictionById.values()].filter((item) => ids.has(item.caseId));
    const metrics = scoreRegression({ referenceCases: references, predictions: submitted });
    return [group, {
      total: metrics.total,
      correct: metrics.correct,
      accuracy: metrics.accuracy,
      f1: metrics.f1,
      specificity: metrics.specificity,
    }];
  }));
}

export function validateRegressionRunners(metadata, candidateCases, frozenTrack) {
  const descriptor = metadata.regressionRunners;
  const frozenRunnerCount = frozenTrack?.lanes?.regression?.runnerCount;
  if (descriptor?.schemaVersion !== 1 || descriptor.strategy !== "app-disjoint"
    || !Number.isInteger(frozenRunnerCount) || frozenRunnerCount < 1
    || descriptor.runnerCount !== frozenRunnerCount
    || !Array.isArray(descriptor.lanes) || descriptor.lanes.length !== descriptor.runnerCount
    || typeof descriptor.isolationEnforcement !== "string" || !descriptor.isolationEnforcement.trim()) {
    throw new Error("run.json regressionRunners must describe the app-disjoint execution lanes");
  }
  const candidateById = new Map(candidateCases.map((item) => [item.id, item]));
  const assignments = {};
  const appOwners = new Map();
  const laneIds = new Set();
  const runnerNames = new Set();
  for (const lane of descriptor.lanes) {
    if (!lane || typeof lane.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(lane.id)
      || laneIds.has(lane.id) || typeof lane.runner !== "string" || !lane.runner.trim()
      || !Array.isArray(lane.caseIds) || lane.caseIds.length === 0 || !Array.isArray(lane.appIds)) {
      throw new Error("run.json regressionRunners contains an invalid lane");
    }
    laneIds.add(lane.id);
    if (runnerNames.has(lane.runner)) throw new Error(`Regression runner is reused across lanes: ${lane.runner}`);
    runnerNames.add(lane.runner);
    if (new Set(lane.caseIds).size !== lane.caseIds.length || new Set(lane.appIds).size !== lane.appIds.length) {
      throw new Error(`Regression runner lane ${lane.id} repeats cases or apps`);
    }
    const actualApps = new Set();
    for (const caseId of lane.caseIds) {
      const candidate = candidateById.get(caseId);
      if (!candidate || assignments[caseId]) throw new Error(`Regression runner assignment is invalid: ${caseId}`);
      actualApps.add(candidate.appId);
      const existingOwner = appOwners.get(candidate.appId);
      if (existingOwner && existingOwner !== lane.id) {
        throw new Error(`Regression app ${candidate.appId} crosses runner lanes`);
      }
      appOwners.set(candidate.appId, lane.id);
      assignments[caseId] = { laneId: lane.id, runner: lane.runner };
    }
    exactInventory(lane.appIds, [...actualApps], `Regression runner lane ${lane.id} app`);
  }
  exactInventory(Object.keys(assignments), candidateCases.map((item) => item.id), "Regression runner case");
  return assignments;
}

export async function loadRun({ runDirectory, cacheDirectory }) {
  const [metadata, generationRaw, mappings, regression, healing, manifest, frozenTrack, archiveManifestBytes] = await Promise.all([
    readJson(path.resolve(runDirectory, "run.json")),
    readJson(path.resolve(runDirectory, "generation.json")),
    readJson(path.resolve(runDirectory, "generation-mappings.json")),
    readJson(path.resolve(runDirectory, "regression.json")),
    readJson(path.resolve(runDirectory, "healing.json")),
    readJson(path.resolve(cacheDirectory, "manifest.json")),
    readJson(path.resolve(HERE, "track.json")),
    readFile(path.resolve(HERE, "webtestbench-app-archives.json")),
  ]);
  if (metadata.trackId !== TRACK_ID || manifest.trackId !== TRACK_ID || frozenTrack.id !== TRACK_ID) {
    throw new Error(`Run and prepared manifest must use ${TRACK_ID}`);
  }
  const archiveManifestDigest = sha256(archiveManifestBytes);
  if (archiveManifestDigest !== frozenTrack.lanes?.regression?.appArchiveManifestSha256) {
    throw new Error("WebTestBench runnable-archive manifest does not match the frozen track");
  }
  const archiveManifest = JSON.parse(archiveManifestBytes.toString("utf8"));
  const [generationCandidate, regressionCandidate, healingCandidate, generationReference, regressionReference, healingReference] = await Promise.all([
    verifiedPreparedFile(cacheDirectory, manifest, frozenTrack, "candidate", "generation"),
    verifiedPreparedFile(cacheDirectory, manifest, frozenTrack, "candidate", "regression"),
    verifiedPreparedFile(cacheDirectory, manifest, frozenTrack, "candidate", "healing"),
    verifiedPreparedFile(cacheDirectory, manifest, frozenTrack, "reference", "generation"),
    verifiedPreparedFile(cacheDirectory, manifest, frozenTrack, "reference", "regression"),
    verifiedPreparedFile(cacheDirectory, manifest, frozenTrack, "reference", "healing"),
  ]);
  for (const prepared of [generationCandidate, regressionCandidate, healingCandidate, generationReference, regressionReference, healingReference]) {
    if (prepared.trackId !== TRACK_ID || !Array.isArray(prepared.cases)) {
      throw new Error(`Prepared files must contain ${TRACK_ID} case arrays`);
    }
  }
  assertCandidateSafe([generationCandidate, regressionCandidate, healingCandidate]);
  exactInventory(generationCandidate.cases.map((item) => item.id), generationReference.cases.map((item) => item.id), "Prepared generation candidate");
  exactInventory(regressionCandidate.cases.map((item) => item.id), regressionReference.cases.map((item) => item.id), "Prepared regression candidate");
  exactInventory(healingCandidate.cases.map((item) => item.id), healingReference.cases.map((item) => item.id), "Prepared healing candidate");
  const regressionCandidates = Object.fromEntries(regressionCandidate.cases.map((item) => [item.id, item]));
  const regressionAssignments = validateRegressionRunners(metadata, regressionCandidate.cases, frozenTrack);
  const appArchives = Object.fromEntries((archiveManifest.apps ?? []).map((item) => [item.appId, item]));
  exactInventory(Object.keys(appArchives), [...new Set(regressionCandidate.cases.map((item) => item.appId))], "WebTestBench runnable archive");
  if (archiveManifest.datasetRevision !== "2feeec346c71f7adb30dff9c64e185bb4cdfc0fe"
    || Object.values(appArchives).some((item) => !/^[a-f0-9]{64}$/.test(item.sha256) || !(item.bytes > 0))) {
    throw new Error("WebTestBench runnable-archive manifest is invalid");
  }
  if (metadata.runId !== path.basename(path.resolve(runDirectory))) {
    throw new Error("run.json runId must match its result directory name");
  }
  for (const [field, value] of Object.entries({
    agent: metadata.agent,
    model: metadata.model,
    publicLabelDisclosure: metadata.publicLabelDisclosure,
    generationProtocol: metadata.protocols?.generation,
    regressionProtocol: metadata.protocols?.regression,
    healingProtocol: metadata.protocols?.healing,
    executionLimitations: metadata.executionLimitations,
  })) {
    if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
      throw new Error(`run.json ${field} must be a non-empty single-line string`);
    }
  }
  if (!Array.isArray(mappings) || !Array.isArray(regression) || !Array.isArray(healing)) {
    throw new Error("Mapping, regression, and healing submissions must be arrays");
  }
  const generation = normalizeGeneration(generationRaw);
  exactInventory(generation.map((item) => item.taskId), generationReference.cases.map((item) => item.id), "Generation task");
  exactInventory(regression.map((item) => item.caseId), regressionReference.cases.map((item) => item.id), "Regression case");
  exactInventory(healing.map((item) => item.caseId), healingReference.cases.map((item) => item.id), "Healing case");
  const healingRunnerValidation = await validateHealingRunner({
    runDirectory,
    metadata,
    healing,
    referenceCases: healingReference.cases,
    frozenTrack,
  });
  return {
    metadata,
    generation,
    mappings,
    regression,
    healing,
    references: {
      generation: generationReference.cases,
      regression: regressionReference.cases,
      healing: healingReference.cases,
    },
    manifest,
    healingRunner: healingRunnerValidation.artifacts,
    healingExpectations: healingRunnerValidation.expectations,
    healingCases: healingRunnerValidation.cases,
    regressionCandidates,
    regressionAssignments,
    appArchives,
    appArchiveManifest: {
      file: "webtestbench-app-archives.json",
      bytes: archiveManifestBytes.length,
      sha256: archiveManifestDigest,
      apps: archiveManifest.apps.length,
    },
  };
}

export async function calculateResult({ runDirectory, cacheDirectory }) {
  const loaded = await loadRun({ runDirectory, cacheDirectory });
  const generation = scoreGeneration({
    referenceCases: loaded.references.generation,
    predictions: loaded.generation,
    mappings: loaded.mappings,
  });
  const regression = scoreRegression({
    referenceCases: loaded.references.regression,
    predictions: loaded.regression,
  });
  regression.byCategory = groupRegression(loaded.references.regression, loaded.regression, "category");
  regression.byDimension = groupRegression(loaded.references.regression, loaded.regression, "dimension");
  const healing = scoreHealing({
    referenceCases: loaded.references.healing,
    predictions: loaded.healing,
  });
  const composite = scoreComposite({ generation, regression, healing });
  const evidence = await inventoryEvidence(runDirectory, loaded.regression, loaded.healing, {
    healingExpectations: loaded.healingExpectations,
    healingCases: loaded.healingCases,
    regressionCandidates: loaded.regressionCandidates,
    regressionAssignments: loaded.regressionAssignments,
    appArchives: loaded.appArchives,
  });
  const inputHashes = {};
  for (const file of INPUT_FILES) {
    const contents = await readFile(path.resolve(runDirectory, file));
    inputHashes[file] = { bytes: contents.length, sha256: sha256(contents) };
  }
  const manifestContents = await readFile(path.resolve(cacheDirectory, "manifest.json"));
  return {
    schemaVersion: 1,
    trackId: TRACK_ID,
    runId: loaded.metadata.runId,
    officialLeaderboardComparable: false,
    disclosure: "Derived, public-label protocol track; not an official WebTestBench or ReproBreak score.",
    generation,
    regression,
    healing,
    composite,
    preparedManifest: {
      sha256: sha256(manifestContents),
      counts: loaded.manifest.counts,
    },
    healingRunner: loaded.healingRunner,
    appArchiveManifest: loaded.appArchiveManifest,
    inputHashes,
    evidence,
  };
}

export function renderReport(result, metadata) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const dimensions = Object.entries(result.regression.byDimension)
    .map(([name, row]) => `| ${name} | ${row.correct}/${row.total} | ${percent(row.accuracy)} | ${percent(row.f1)} | ${percent(row.specificity)} |`)
    .join("\n");
  return `# Auto-QA Core result — ${result.runId}

This is a derived public-label protocol track, not an official upstream leaderboard result. The checked artifacts are independently re-scoreable; this report does not claim a fully rerunnable model evaluation.

| Lane | Primary result |
| --- | ---: |
| Candidate-masked test generation | F1 ${percent(result.generation.f1)} · precision ${percent(result.generation.precision)} · recall ${percent(result.generation.recall)} |
| WebTestBench-derived defect verdicts | ${result.regression.correct}/${result.regression.total} · accuracy ${percent(result.regression.accuracy)} · F1 ${percent(result.regression.f1)} · specificity ${percent(result.regression.specificity)} |
| Healing/control conformance | ${result.healing.safeHeals}/${result.healing.total} safe · true regressions ${result.healing.correctRegressions}/${result.healing.total} protected · false-heal ${percent(result.healing.falseHealRate)} |
| Safety-gated composite | **${percent(result.composite.score)}** |

Composite eligible: **${result.composite.eligible ? "yes" : "no"}**. Evidence artifacts: ${result.evidence.length}.

## Regression performance by QA dimension

| Dimension | Correct | Accuracy | Fail F1 | Specificity |
| --- | ---: | ---: | ---: | ---: |
${dimensions}

## Runtime disclosure

- Agent: ${metadata.agent}
- Model: ${metadata.model}
- Generation protocol: ${metadata.protocols.generation}
- Regression protocol: ${metadata.protocols.regression}
- Healing protocol: ${metadata.protocols.healing}
- Execution limitations: ${metadata.executionLimitations}
- Public-label disclosure: ${metadata.publicLabelDisclosure}
`;
}
