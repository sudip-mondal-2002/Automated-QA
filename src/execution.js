import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { detectNativeCapability } from "./native-executor.js";
import { prepareEnvironment } from "./environment.js";
import { QaError } from "./errors.js";
import {
  classifyFailure,
  createExpectationGuard,
  normalizeRediscovery,
  normalizeTarget,
} from "./healing.js";
import { redactSensitive, resolveReferences } from "./references.js";

const STEP_STATUSES = new Set(["passed", "failed", "blocked"]);
const SCREENSHOT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

function instant(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function createRunId(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  return `run_${timestamp}_${randomBytes(3).toString("hex")}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function mergeOutputs(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (!new Set(["__proto__", "constructor", "prototype"]).has(key)) target[key] = value;
  }
}

function normalizeObservation(expectation, response) {
  if (typeof response === "boolean") {
    return { expectation, status: response ? "passed" : "failed" };
  }
  const status = response?.status ?? (response?.passed === true ? "passed" : response?.passed === false ? "failed" : undefined);
  if (!STEP_STATUSES.has(status)) {
    throw new QaError("INVALID_NATIVE_RESPONSE", "Native executor returned an invalid observation status");
  }
  return {
    expectation,
    status,
    ...(response.observation ? { observation: String(response.observation) } : {}),
  };
}

async function observeExpectations(executor, expectations, context) {
  const results = [];
  for (const expectation of expectations) {
    try {
      results.push(normalizeObservation(expectation, await executor.observe(expectation, context)));
    } catch (error) {
      results.push({
        expectation,
        status: error?.code === "NATIVE_BLOCKED" ? "blocked" : "failed",
        observation: errorMessage(error),
      });
    }
  }
  return results;
}

function expectationStatus(expectations) {
  return expectations.some((entry) => entry.status === "blocked")
    ? "blocked"
    : expectations.some((entry) => entry.status === "failed") ? "failed" : "passed";
}

async function screenshotArtifact(artifact) {
  if (Buffer.isBuffer(artifact) || artifact instanceof Uint8Array) {
    return { contents: artifact, extension: "png" };
  }
  if (!artifact || typeof artifact !== "object") {
    throw new QaError("INVALID_SCREENSHOT", "Native executor did not return screenshot data");
  }
  let contents = artifact.data;
  let extension = artifact.extension?.toLowerCase();
  if (artifact.path) {
    contents = await readFile(artifact.path);
    extension ||= extname(artifact.path).slice(1).toLowerCase();
  }
  if (typeof contents === "string" && artifact.encoding === "base64") contents = Buffer.from(contents, "base64");
  if (!(Buffer.isBuffer(contents) || contents instanceof Uint8Array) || !SCREENSHOT_EXTENSIONS.has(extension)) {
    throw new QaError("INVALID_SCREENSHOT", "Native executor returned an unsupported screenshot artifact");
  }
  return { contents, extension };
}

class EventJournal {
  constructor(clock, onEvent, redact) {
    this.clock = clock;
    this.onEvent = onEvent;
    this.redact = redact;
    this.events = [];
  }

  async add(type, details = {}) {
    const event = this.redact({
      sequence: this.events.length + 1,
      at: instant(this.clock),
      type,
      ...details,
    });
    this.events.push(event);
    await this.onEvent?.(event);
    return event;
  }
}

async function executeSemanticStep(executor, item, context) {
  let action;
  try {
    action = await executor.act(item.intent, context);
  } catch (error) {
    const status = error?.code === "NATIVE_BLOCKED" ? "blocked" : "failed";
    return {
      status,
      expectations: item.expectations.map((expectation) => ({
        expectation,
        status,
        observation: errorMessage(error),
      })),
      explanation: errorMessage(error),
      failure: { stage: "action", status, explanation: errorMessage(error) },
    };
  }

  if (action?.status === "blocked" || action?.status === "failed") {
    const status = action.status;
    const selectedTarget = normalizeTarget(action.selectedTarget);
    const explanation = action.observation ? String(action.observation) : `Action ${status}`;
    return {
      status,
      expectations: item.expectations.map((expectation) => ({
        expectation,
        status,
        ...(action.observation ? { observation: String(action.observation) } : {}),
      })),
      ...(selectedTarget ? { selectedTarget } : {}),
      explanation,
      failure: {
        stage: "action",
        status,
        explanation,
        ...(selectedTarget ? { previousTarget: selectedTarget } : {}),
      },
    };
  }

  mergeOutputs(context.outputs, action?.outputs);
  const expectations = await observeExpectations(executor, item.expectations, context);
  const status = expectationStatus(expectations);
  const selectedTarget = normalizeTarget(action?.selectedTarget);
  const problem = expectations.find((entry) => entry.status !== "passed");
  return {
    status,
    expectations,
    ...(selectedTarget ? { selectedTarget } : {}),
    ...(problem ? {
      failure: {
        stage: "expectation",
        status,
        explanation: problem.observation || `${problem.expectation}: ${problem.status}`,
        ...(selectedTarget ? { previousTarget: selectedTarget } : {}),
      },
    } : {}),
  };
}

async function observeFixturePostconditions(executor, fixture, context) {
  return observeExpectations(executor, fixture.expect, context);
}

function fixtureExplanation(expectations, fallback) {
  const problem = expectations.find((entry) => entry.status !== "passed");
  if (problem) return problem.observation || `${problem.expectation}: ${problem.status}`;
  return fallback;
}

function skippedStep(step, index) {
  return {
    index,
    intent: step.intent,
    status: "skipped",
    expectations: step.expect.map((expectation) => ({ expectation, status: "skipped" })),
  };
}

function healingEventStatus(classification) {
  if (classification === "healed") return "passed";
  return classification === "blocked" ? "blocked" : "failed";
}

function healingOutcome(classification) {
  if (classification === "healed") return "healed";
  return classification === "blocked" ? "blocked" : "failed";
}

function originalFailureExplanation(failure, previousTarget) {
  const explanation = failure.explanation || `${failure.stage} ${failure.status}`;
  return previousTarget
    ? `${explanation}. Previous target: ${previousTarget.summary}`
    : explanation;
}

async function attemptHealing(executor, item, context, failed, hooks = {}) {
  if (failed.status !== "failed" || !failed.failure) return failed;

  const guard = createExpectationGuard(item.expectations);
  const previousTarget = failed.failure.previousTarget ?? context.previousTarget;
  const failure = { ...failed.failure, previousTarget };
  const canRediscover = failure.stage === "action" && executor.supports?.("rediscover") === true;
  const canWait = failure.stage === "expectation" && executor.supports?.("waitFor") === true;
  let decision = classifyFailure({
    failure,
    ...(failure.stage === "action" ? { rediscovery: canRediscover ? undefined : null } : {}),
    readinessAvailable: canWait,
  });
  if (!new Set(["rediscover_target", "wait_for_readiness"]).has(decision.decision)) return failed;

  const strategy = decision.decision === "rediscover_target" ? "target_rediscovery" : "readiness_wait";
  const details = { phase: "test", stepIndex: context.stepIndex };
  await hooks.event?.("healing_started", {
    ...details,
    message: originalFailureExplanation(failure, previousTarget),
  });
  const beforeScreenshot = await hooks.capture?.(`healing-before-step-${context.stepIndex}`, details);
  let replacement = strategy === "readiness_wait"
    ? `Observable readiness for: ${guard.expectations.filter((expectation) => (
      failed.expectations.find((entry) => entry.expectation === expectation)?.status !== "passed"
    )).join("; ")}`
    : "No equivalent target selected";
  let selectedTarget = failed.selectedTarget ?? previousTarget;
  let expectations = failed.expectations;
  let verification;

  try {
    if (strategy === "target_rediscovery") {
      let rediscovery;
      try {
        rediscovery = normalizeRediscovery(await executor.rediscover(item.intent, {
          ...context,
          failure: {
            stage: failure.stage,
            status: failure.status,
            explanation: failure.explanation,
          },
          currentObservation: failure.explanation,
          previousTarget,
          expectations: guard.expectations,
        }));
      } catch (error) {
        rediscovery = {
          status: error?.code === "NATIVE_BLOCKED" ? "blocked" : "ambiguous",
          explanation: errorMessage(error),
        };
      }
      decision = classifyFailure({ failure, rediscovery });
      if (decision.decision !== "retry_equivalent_target") {
        verification = {
          status: decision.classification === "blocked" ? "blocked" : "failed",
          explanation: decision.reason,
        };
      } else {
        selectedTarget = rediscovery.target;
        replacement = selectedTarget.summary;
        let action;
        try {
          action = await executor.recover(item.intent, selectedTarget, {
            ...context,
            healing: true,
            originalFailure: failure.explanation,
            previousTarget,
          });
        } catch (error) {
          action = {
            status: error?.code === "NATIVE_BLOCKED" ? "blocked" : "failed",
            observation: errorMessage(error),
          };
        }
        if (action?.status === "blocked" || action?.status === "failed") {
          const status = action.status;
          const explanation = action.observation ? String(action.observation) : `Replacement action ${status}`;
          expectations = guard.expectations.map((expectation) => ({ expectation, status, observation: explanation }));
          verification = { status, explanation };
        } else {
          mergeOutputs(context.outputs, action?.outputs);
          selectedTarget = normalizeTarget(action?.selectedTarget) ?? selectedTarget;
          guard.assertUnchanged();
          expectations = await observeExpectations(executor, guard.expectations, {
            ...context,
            healing: true,
            selectedTarget,
          });
          verification = {
            status: expectationStatus(expectations),
            explanation: expectations.find((entry) => entry.status !== "passed")?.observation,
          };
        }
      }
    } else {
      for (const expectation of guard.expectations) {
        const initial = failed.expectations.find((entry) => entry.expectation === expectation);
        if (initial?.status === "passed") continue;
        try {
          const waitResult = normalizeObservation(expectation, await executor.waitFor(expectation, {
            ...context,
            healing: true,
            previousTarget,
          }));
          if (waitResult.status === "blocked") {
            verification = { status: "blocked", explanation: waitResult.observation };
            break;
          }
        } catch (error) {
          verification = { status: "blocked", explanation: errorMessage(error) };
          break;
        }
      }
      if (!verification) {
        guard.assertUnchanged();
        expectations = await observeExpectations(executor, guard.expectations, {
          ...context,
          healing: true,
          selectedTarget,
        });
        verification = {
          status: expectationStatus(expectations),
          explanation: expectations.find((entry) => entry.status !== "passed")?.observation,
        };
      }
    }
    guard.assertUnchanged();
  } catch (error) {
    verification = { status: "blocked", explanation: errorMessage(error) };
  }

  decision = classifyFailure({
    failure,
    verification,
    recoveryAttempted: true,
    expectationsUnchanged: true,
  });
  const afterScreenshot = await hooks.capture?.(`healing-after-step-${context.stepIndex}`, details);
  if (decision.classification === "healed" && (!beforeScreenshot || !afterScreenshot)) {
    decision = {
      decision: "blocked",
      classification: "blocked",
      reason: "Recovery passed but required before/after screenshot evidence is unavailable",
    };
    verification = { status: "blocked", explanation: decision.reason };
  }

  const classification = decision.classification;
  const healing = {
    strategy,
    outcome: healingOutcome(classification),
    originalFailure: originalFailureExplanation(failure, previousTarget),
    replacement,
    verification: decision.reason,
    ...(beforeScreenshot ? { beforeScreenshot } : {}),
    ...(afterScreenshot ? { afterScreenshot } : {}),
  };
  await hooks.event?.("healing_completed", {
    ...details,
    status: healingEventStatus(classification),
    message: `${replacement}: ${decision.reason}`,
  });
  return {
    status: classification === "healed" ? "passed" : classification === "blocked" ? "blocked" : "failed",
    expectations,
    ...(selectedTarget ? { selectedTarget } : {}),
    explanation: verification.explanation || decision.reason,
    healing,
    failure,
  };
}

async function previousTargetsFor(workspace, specId, environment) {
  try {
    const selected = await workspace.readLastTest();
    if (selected.specId !== specId || selected.environment !== environment || !selected.lastRunId) return new Map();
    const previous = await workspace.loadResult(selected.lastRunId);
    return new Map(previous.steps.flatMap((step) => {
      const target = normalizeTarget(step.selectedTarget);
      return target ? [[step.index, target]] : [];
    }));
  } catch {
    return new Map();
  }
}

export async function executeRun(options) {
  const {
    workspace,
    specId,
    executor,
    variables = process.env,
    signal,
    onEvent,
    clock = () => new Date(),
  } = options;
  const startedAt = instant(clock);
  const runId = options.runId ?? createRunId(new Date(startedAt));
  const sensitiveValues = new Set();
  const redact = (value) => redactSensitive(value, sensitiveValues);
  const journal = new EventJournal(clock, onEvent, redact);
  const result = {
    version: 1,
    runId,
    specId,
    environment: options.environmentId,
    classification: "blocked",
    startedAt,
    completedAt: startedAt,
    explanation: "Run did not start",
    steps: [],
    fixtures: [],
    evidence: { screenshots: [], consoleErrors: [], networkErrors: [], unsupported: [] },
    events: journal.events,
  };
  const outputs = Object.create(null);
  let spec;
  let resolvedEnvironment;
  let startedApplication;
  let primaryClassification = "passed";
  let primaryExplanation = "All declared expectations passed";
  let canExecuteCleanup = false;
  let previousTargets = new Map();
  let healedSteps = 0;

  const capture = async (label, details = {}) => {
    try {
      const artifact = await screenshotArtifact(await executor.screenshot({
        runId,
        checkpoint: label,
        avoidSensitiveFields: true,
        outputs,
      }));
      const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "checkpoint";
      const fileName = `${String(journal.events.length + 1).padStart(3, "0")}-${safeLabel}.${artifact.extension}`;
      const relativePath = await workspace.saveScreenshot(runId, fileName, artifact.contents);
      result.evidence.screenshots.push(relativePath);
      await journal.add("screenshot_captured", { message: relativePath, ...details });
      return relativePath;
    } catch (error) {
      const notice = `screenshot capture: ${errorMessage(error)}`;
      if (!result.evidence.unsupported.includes(notice)) result.evidence.unsupported.push(notice);
      await journal.add("capability_notice", { status: "blocked", message: notice, ...details });
      return undefined;
    }
  };

  const runFixture = async (fixtureId, phase, betweenAfterStep) => {
    const fixture = await workspace.loadFixture(fixtureId);
    const fixtureDetails = {
      phase,
      fixtureId,
      ...(betweenAfterStep ? { stepIndex: betweenAfterStep } : {}),
    };
    await journal.add("fixture_started", fixtureDetails);
    let inputs;
    try {
      const resolved = resolveReferences(fixture.inputs ?? {}, { variables, outputs });
      inputs = resolved.value;
      for (const secret of resolved.sensitiveValues) sensitiveValues.add(secret);
    } catch (error) {
      const explanation = redact(errorMessage(error));
      result.fixtures.push({ fixtureId, phase, status: "blocked", explanation });
      await journal.add("fixture_completed", { ...fixtureDetails, status: "blocked", message: explanation });
      return "blocked";
    }

    let status = "passed";
    let explanation = `Verified ${fixture.expect.length} fixture postcondition${fixture.expect.length === 1 ? "" : "s"}`;
    for (const [index, step] of fixture.steps.entries()) {
      if (signal?.aborted) {
        status = "blocked";
        explanation = "Run was cancelled";
        break;
      }
      const stepResult = await executeSemanticStep(executor, {
        intent: step.intent,
        expectations: step.expect ?? [],
      }, {
        runId,
        scope: "fixture",
        phase,
        fixtureId,
        fixtureStepIndex: index + 1,
        inputs,
        outputs,
        target: resolvedEnvironment,
        signal,
      });
      if (stepResult.status !== "passed") {
        status = stepResult.status;
        explanation = stepResult.explanation || `Fixture step ${index + 1} ${stepResult.status}`;
        break;
      }
    }
    if (status === "passed") {
      const postconditions = await observeFixturePostconditions(executor, fixture, {
        runId,
        scope: "fixture",
        phase,
        fixtureId,
        inputs,
        outputs,
        target: resolvedEnvironment,
        signal,
      });
      status = postconditions.some((entry) => entry.status === "blocked")
        ? "blocked"
        : postconditions.some((entry) => entry.status === "failed") ? "failed" : "passed";
      explanation = fixtureExplanation(postconditions, explanation);
    }
    explanation = redact(explanation);
    result.fixtures.push({ fixtureId, phase, status, explanation });
    await capture(`${status === "passed" ? "checkpoint" : "failure"}-${phase}-${fixtureId}`, fixtureDetails);
    await journal.add("fixture_completed", { ...fixtureDetails, status, message: explanation });
    return status;
  };

  await journal.add("run_started", { message: `Running ${specId}` });

  try {
    spec = await workspace.loadSpec(specId);
    result.environment = options.environmentId ?? spec.environment;
    previousTargets = await previousTargetsFor(workspace, specId, result.environment);
    const environmentDocument = await workspace.loadEnvironments();
    const environment = environmentDocument.environments[result.environment];
    if (!environment) {
      throw new QaError("UNKNOWN_ENVIRONMENT", `Unknown environment: ${result.environment}`);
    }
    const resolved = resolveReferences(environment, { variables, outputs });
    resolvedEnvironment = resolved.value;
    for (const secret of resolved.sensitiveValues) sensitiveValues.add(secret);

    const capability = await detectNativeCapability(resolvedEnvironment, executor);
    result.evidence.unsupported.push(...(capability.unsupported ?? []));
    if (!capability.available) {
      primaryClassification = "blocked";
      primaryExplanation = capability.explanation;
      await journal.add("capability_notice", { status: "blocked", message: primaryExplanation });
    } else {
      const prepared = await prepareEnvironment(resolvedEnvironment, {
        repositoryRoot: workspace.repositoryRoot,
        fetchImpl: options.fetchImpl,
        startApplication: options.startApplication,
        startupTimeoutMs: options.startupTimeoutMs,
        signal,
      });
      resolvedEnvironment = prepared.target;
      startedApplication = prepared.startedApplication;
      await executor.connect(resolvedEnvironment, { runId, signal });
      canExecuteCleanup = true;
      await journal.add("environment_ready", { status: "passed", message: `${resolvedEnvironment.type} environment is ready` });

      for (const fixtureId of spec.fixtures?.before ?? []) {
        const status = await runFixture(fixtureId, "before");
        if (status !== "passed") {
          primaryClassification = "blocked";
          primaryExplanation = `Before fixture ${fixtureId} ${status}`;
          break;
        }
      }

      if (primaryClassification === "passed") {
        for (const [zeroIndex, step] of spec.steps.entries()) {
          const index = zeroIndex + 1;
          if (signal?.aborted) {
            primaryClassification = "blocked";
            primaryExplanation = "Run was cancelled";
            break;
          }
          await journal.add("step_started", { phase: "test", stepIndex: index, message: step.intent });
          const stepContext = {
            runId,
            scope: "test",
            stepIndex: index,
            outputs,
            target: resolvedEnvironment,
            signal,
            previousTarget: previousTargets.get(index),
          };
          let executed = await executeSemanticStep(executor, {
            intent: step.intent,
            expectations: step.expect,
          }, stepContext);
          if (executed.status === "failed") {
            executed = await attemptHealing(executor, {
              intent: step.intent,
              expectations: step.expect,
            }, stepContext, executed, {
              capture,
              event: (type, details) => journal.add(type, details),
            });
          }
          if (executed.healing?.outcome === "healed") healedSteps += 1;
          const recorded = redact({
            index,
            intent: step.intent,
            status: executed.status,
            expectations: executed.expectations,
            ...(executed.selectedTarget ? { selectedTarget: executed.selectedTarget } : {}),
            ...(executed.healing ? { healing: executed.healing } : {}),
          });
          result.steps.push(recorded);
          await capture(`${executed.status === "passed" ? "checkpoint" : "failure"}-step-${index}`, {
            phase: "test",
            stepIndex: index,
          });
          await journal.add("step_completed", {
            phase: "test",
            stepIndex: index,
            status: executed.status,
            message: executed.status === "passed" ? "Expectations passed" : "Expectation or action failed",
          });
          if (executed.status !== "passed") {
            primaryClassification = executed.status === "blocked" ? "blocked" : "functional_regression";
            primaryExplanation = executed.explanation
              || executed.expectations.find((entry) => entry.status !== "passed")?.observation
              || `Step ${index} ${executed.status}`;
            break;
          }

          const betweenGroups = (spec.fixtures?.between ?? []).filter((entry) => entry.afterStep === index);
          for (const group of betweenGroups) {
            for (const fixtureId of group.fixtures) {
              const status = await runFixture(fixtureId, "between", index);
              if (status !== "passed") {
                primaryClassification = "blocked";
                primaryExplanation = `Between-step fixture ${fixtureId} ${status}`;
                break;
              }
            }
            if (primaryClassification !== "passed") break;
          }
          if (primaryClassification !== "passed") break;
        }
      }

      for (let index = result.steps.length; index < spec.steps.length; index += 1) {
        result.steps.push(skippedStep(spec.steps[index], index + 1));
      }
    }
  } catch (error) {
    primaryClassification = "blocked";
    primaryExplanation = redact(errorMessage(error));
    await journal.add("capability_notice", { status: "blocked", message: primaryExplanation });
  } finally {
    if (spec && canExecuteCleanup) {
      await journal.add("cleanup_started", { phase: "after", message: "Running after fixtures" });
      for (const fixtureId of spec.fixtures?.after ?? []) {
        try {
          await runFixture(fixtureId, "after");
        } catch (error) {
          const explanation = redact(errorMessage(error));
          result.fixtures.push({ fixtureId, phase: "after", status: "blocked", explanation });
          await journal.add("fixture_completed", { phase: "after", fixtureId, status: "blocked", message: explanation });
        }
      }
      const cleanupFailed = result.fixtures.some((fixture) => fixture.phase === "after" && fixture.status !== "passed");
      await journal.add("cleanup_completed", {
        phase: "after",
        status: cleanupFailed ? "failed" : "passed",
        message: cleanupFailed ? "One or more cleanup fixtures failed" : "Cleanup completed",
      });
    }

    if (executor) {
      try {
        const consoleErrors = await executor.consoleErrors?.({ runId, target: resolvedEnvironment, signal });
        const networkErrors = await executor.networkErrors?.({ runId, target: resolvedEnvironment, signal });
        if (Array.isArray(consoleErrors)) result.evidence.consoleErrors.push(...redact(consoleErrors).map(String));
        if (Array.isArray(networkErrors)) result.evidence.networkErrors.push(...redact(networkErrors).map(String));
      } catch (error) {
        result.evidence.unsupported.push(redact(`error inspection: ${errorMessage(error)}`));
      }
      try {
        await executor.close?.({ runId, target: resolvedEnvironment });
      } catch {}
    }
    try {
      await startedApplication?.stop?.();
    } catch {}
  }

  if (primaryClassification === "passed" && healedSteps > 0) {
    primaryClassification = "healed";
    primaryExplanation = `Recovered ${healedSteps} interaction${healedSteps === 1 ? "" : "s"} and verified every original expectation unchanged`;
  }
  result.classification = primaryClassification;
  const cleanupProblems = result.fixtures.filter((fixture) => fixture.phase === "after" && fixture.status !== "passed");
  result.explanation = redact(cleanupProblems.length > 0
    ? `${primaryExplanation}. Cleanup issue: ${cleanupProblems.map((fixture) => `${fixture.fixtureId} ${fixture.status}`).join(", ")}`
    : primaryExplanation);
  await journal.add("run_completed", {
    status: new Set(["passed", "healed"]).has(result.classification) ? "passed" : "failed",
    message: result.explanation,
  });
  result.completedAt = instant(clock);
  await workspace.saveResult(result);
  return result;
}
