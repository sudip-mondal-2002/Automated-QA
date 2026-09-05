import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { detectNativeCapability } from "./native-executor.js";
import { prepareEnvironment } from "./environment.js";
import { QaError } from "./errors.js";
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

function normalizeSelectedTarget(value) {
  if (!value || typeof value !== "object") return undefined;
  const role = value.role ? String(value.role) : undefined;
  const name = value.name ? String(value.name) : undefined;
  const summary = value.summary ? String(value.summary) : [role, name].filter(Boolean).join(" ");
  if (!summary) return undefined;
  return {
    summary,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
  };
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
    return {
      status: error?.code === "NATIVE_BLOCKED" ? "blocked" : "failed",
      expectations: item.expectations.map((expectation) => ({
        expectation,
        status: error?.code === "NATIVE_BLOCKED" ? "blocked" : "failed",
        observation: errorMessage(error),
      })),
      explanation: errorMessage(error),
    };
  }

  if (action?.status === "blocked" || action?.status === "failed") {
    const status = action.status;
    const selectedTarget = normalizeSelectedTarget(action.selectedTarget);
    return {
      status,
      expectations: item.expectations.map((expectation) => ({
        expectation,
        status,
        ...(action.observation ? { observation: String(action.observation) } : {}),
      })),
      ...(selectedTarget ? { selectedTarget } : {}),
      ...(action.observation ? { explanation: String(action.observation) } : {}),
    };
  }

  mergeOutputs(context.outputs, action?.outputs);
  const expectations = [];
  for (const expectation of item.expectations) {
    try {
      expectations.push(normalizeObservation(expectation, await executor.observe(expectation, context)));
    } catch (error) {
      expectations.push({
        expectation,
        status: error?.code === "NATIVE_BLOCKED" ? "blocked" : "failed",
        observation: errorMessage(error),
      });
    }
  }
  const status = expectations.some((entry) => entry.status === "blocked")
    ? "blocked"
    : expectations.some((entry) => entry.status === "failed") ? "failed" : "passed";
  const selectedTarget = normalizeSelectedTarget(action?.selectedTarget);
  return {
    status,
    expectations,
    ...(selectedTarget ? { selectedTarget } : {}),
  };
}

async function observeFixturePostconditions(executor, fixture, context) {
  const expectations = [];
  for (const expectation of fixture.expect) {
    try {
      expectations.push(normalizeObservation(expectation, await executor.observe(expectation, context)));
    } catch (error) {
      expectations.push({
        expectation,
        status: error?.code === "NATIVE_BLOCKED" ? "blocked" : "failed",
        observation: errorMessage(error),
      });
    }
  }
  return expectations;
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
    } catch (error) {
      const notice = `screenshot capture: ${errorMessage(error)}`;
      if (!result.evidence.unsupported.includes(notice)) result.evidence.unsupported.push(notice);
      await journal.add("capability_notice", { status: "blocked", message: notice, ...details });
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
          const executed = await executeSemanticStep(executor, {
            intent: step.intent,
            expectations: step.expect,
          }, {
            runId,
            scope: "test",
            stepIndex: index,
            outputs,
            target: resolvedEnvironment,
            signal,
          });
          const recorded = redact({
            index,
            intent: step.intent,
            status: executed.status,
            expectations: executed.expectations,
            ...(executed.selectedTarget ? { selectedTarget: executed.selectedTarget } : {}),
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

  result.classification = primaryClassification;
  const cleanupProblems = result.fixtures.filter((fixture) => fixture.phase === "after" && fixture.status !== "passed");
  result.explanation = redact(cleanupProblems.length > 0
    ? `${primaryExplanation}. Cleanup issue: ${cleanupProblems.map((fixture) => `${fixture.fixtureId} ${fixture.status}`).join(", ")}`
    : primaryExplanation);
  await journal.add("run_completed", { status: result.classification === "passed" ? "passed" : "failed", message: result.explanation });
  result.completedAt = instant(clock);
  await workspace.saveResult(result);
  return result;
}
