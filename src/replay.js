import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRunId, executeRun } from "./execution.js";
import { prepareEnvironment } from "./environment.js";
import { QaError } from "./errors.js";

export const REPLAY_GENERATOR_VERSION = "1";
export const REPLAY_VALIDATION_RUNS = 3;
const DESTRUCTIVE_INTENT = /\b(delete|remove|purchase|pay|submit|send|place\s+order|create|transfer|refund)\b/i;
const FORBIDDEN_SOURCE = [
  [/\bimport\b/, "imports"],
  [/\brequire\s*\(/, "require"],
  [/\b(?:process|globalThis|eval|Function|fetch)\b/, "unsafe globals"],
  [/waitForTimeout|networkidle/, "fixed or network-idle waits"],
  [/\.\s*(?:first|last|nth)\s*\(/, "positional locators"],
  [/force\s*:\s*true/, "forced actions"],
  [/test\.(?:skip|fixme)|\.skip\s*\(/, "skipped checks"],
  [/\.(?:evaluate|evaluateAll|waitForFunction|addScriptTag|addInitScript|exposeFunction|route)\s*\(/, "arbitrary page execution"],
  [/\b(?:child_process|node:fs|node:net|node:http)\b/, "Node system modules"],
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function replayHash(value) {
  const source = typeof value === "string" ? value : JSON.stringify(canonical(value));
  return createHash("sha256").update(source).digest("hex");
}

function fixtureOccurrences(spec) {
  return [
    ...(spec.fixtures?.before ?? []).map((fixtureId) => ({ fixtureId, phase: "before" })),
    ...(spec.fixtures?.between ?? []).flatMap((group) => group.fixtures.map((fixtureId) => ({ fixtureId, phase: "between", afterStep: group.afterStep }))),
    ...(spec.fixtures?.after ?? []).map((fixtureId) => ({ fixtureId, phase: "after" })),
  ];
}

export async function replaySource(workspace, specId, environmentId) {
  const spec = await workspace.loadSpec(specId);
  const environments = await workspace.loadEnvironments();
  const environment = environments.environments[environmentId ?? spec.environment];
  if (!environment) throw new QaError("UNKNOWN_ENVIRONMENT", `Unknown environment: ${environmentId}`);
  const fixtures = [];
  for (const id of [...new Set(fixtureOccurrences(spec).map((entry) => entry.fixtureId))]) {
    fixtures.push(await workspace.loadFixture(id));
  }
  const source = { spec, environment, fixtures, generatorVersion: REPLAY_GENERATOR_VERSION };
  return { ...source, sourceHash: replayHash(source) };
}

export function validateReplayScriptSource(source) {
  if (typeof source !== "string" || !/^export\s+default\s+async\s+function\s+replay\s*\(/m.test(source)) {
    throw new QaError("INVALID_REPLAY_SCRIPT", "Replay must export `async function replay` as its default export");
  }
  for (const [pattern, label] of FORBIDDEN_SOURCE) {
    if (pattern.test(source)) throw new QaError("UNSAFE_REPLAY_SCRIPT", `Replay contains forbidden ${label}`);
  }
  const checkpointCount = (source.match(/\bcheckpoint\s*\(/g) ?? []).length;
  const assertedCheckpointCount = (source.match(/\bcheckpoint\s*\([^;]+?\bexpect\s*\(/gs) ?? []).length;
  if (checkpointCount !== assertedCheckpointCount) {
    throw new QaError("INCOMPLETE_REPLAY_COVERAGE", "Every replay checkpoint must execute a Playwright assertion");
  }
  return source;
}

function locatorCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const strategy = candidate.strategy;
  if (!new Set(["role", "label", "text", "testid", "css"]).has(strategy)) return null;
  return { strategy, value: candidate.value };
}

function assertionSource(predicate, locatorExpression) {
  if (!predicate?.kind) return null;
  const value = JSON.stringify(predicate.value);
  if (predicate.kind === "text" && predicate.value) return `await expect(page.getByText(${value}, { exact: false })).toBeVisible()`;
  if (predicate.kind === "absent_text" && predicate.value) return `await expect(page.getByText(${value}, { exact: false })).toHaveCount(0)`;
  if (predicate.kind === "url_contains" && predicate.value) return `await expect(page).toHaveURL(new RegExp(${JSON.stringify(String(predicate.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}))`;
  if (predicate.kind === "visible" && locatorExpression) return `await expect(${locatorExpression}).toBeVisible()`;
  if (predicate.kind === "absent" && locatorExpression) return `await expect(${locatorExpression}).toHaveCount(0)`;
  if (predicate.kind === "count" && locatorExpression && Number.isInteger(predicate.count)) return `await expect(${locatorExpression}).toHaveCount(${predicate.count})`;
  return null;
}

function candidateExpression(candidates) {
  const usable = (candidates ?? []).map(locatorCandidate).filter(Boolean);
  return `await target(${JSON.stringify(usable)})`;
}

export function renderReplayFromBindings({ spec, bindings = [], origin, auth } = {}) {
  const lines = [
    "// Generated Playwright replay. Semantic YAML remains the source of truth.",
    "export default async function replay({ page, expect, checkpoint, target, value, baseURL }) {",
  ];
  let deterministic = 0;
  const total = (spec?.steps ?? []).reduce((sum, step) => sum + step.expect.length, 0);
  if (auth) {
    lines.push(`  await page.goto(new URL(${JSON.stringify(auth.loginPath ?? "/login")}, baseURL).href);`);
    lines.push(`  await (await target(${JSON.stringify([{ strategy: "css", value: `[name="${auth.userField}"]` }])})).fill(value("\${QA_USERNAME}"));`);
    lines.push(`  await (await target(${JSON.stringify([{ strategy: "css", value: `[name="${auth.passwordField}"]` }])})).fill(value("\${QA_PASSWORD}"));`);
    lines.push(`  await (await target(${JSON.stringify([{ strategy: "role", value: ["button", { name: auth.submitLabel }] }])})).click();`);
  }
  (spec?.steps ?? []).forEach((step, index) => {
    const binding = bindings[index] ?? {};
    const pagePath = binding.page ?? "/";
    const previous = index > 0 ? bindings[index - 1]?.page : null;
    if (index === 0 || pagePath !== previous) lines.push(`  await page.goto(new URL(${JSON.stringify(pagePath)}, baseURL).href);`);
    for (const input of binding.inputs ?? []) {
      lines.push(`  await (${candidateExpression(input.candidates)}).fill(value(${JSON.stringify(input.value ?? "")}));`);
    }
    if (binding.action === "click" || binding.action === "submit") {
      lines.push(`  await (${candidateExpression(binding.candidates)}).click();`);
    }
    (binding.expectations ?? []).forEach((expectation, expectationIndex) => {
      const expression = assertionSource(expectation.predicate, expectation.predicate?.selector ? `page.locator(${JSON.stringify(expectation.predicate.selector)})` : null);
      if (!expression) return;
      deterministic += 1;
      lines.push(`  await checkpoint(${index + 1}, ${expectationIndex}, async () => { ${expression}; });`);
    });
  });
  lines.push("}", "");
  return { script: lines.join("\n"), coverage: { deterministic, total, complete: deterministic === total } };
}

function descriptorLocator(descriptor) {
  if (!descriptor?.locator) return null;
  return `await target(${JSON.stringify([descriptor.locator])})`;
}

function renderRecordedAction(action) {
  if (!action?.kind) return null;
  if (action.kind === "goto" && action.path) return `await page.goto(new URL(${JSON.stringify(action.path)}, baseURL).href);`;
  const locator = descriptorLocator(action);
  if (!locator) return null;
  if (action.kind === "click") return `await (${locator}).click();`;
  if (action.kind === "fill") return `await (${locator}).fill(value(${JSON.stringify(action.valueRef ?? action.value ?? "")}));`;
  if (action.kind === "press" && action.key) return `await (${locator}).press(${JSON.stringify(action.key)});`;
  if (action.kind === "check") return `await (${locator}).check();`;
  if (action.kind === "select" && action.value !== undefined) return `await (${locator}).selectOption(${JSON.stringify(action.value)});`;
  return null;
}

function renderRecordedAssertion(assertion) {
  const locator = descriptorLocator(assertion);
  if (assertion?.kind === "url" && assertion.value) return `await expect(page).toHaveURL(new RegExp(${JSON.stringify(assertion.value)}));`;
  if (!locator) return null;
  if (assertion.kind === "visible") return `await expect(${locator}).toBeVisible();`;
  if (assertion.kind === "hidden") return `await expect(${locator}).toBeHidden();`;
  if (assertion.kind === "text" && assertion.value !== undefined) return `await expect(${locator}).toContainText(${JSON.stringify(assertion.value)});`;
  if (assertion.kind === "value" && assertion.value !== undefined) return `await expect(${locator}).toHaveValue(${JSON.stringify(assertion.value)});`;
  if (assertion.kind === "count" && Number.isInteger(assertion.count)) return `await expect(${locator}).toHaveCount(${assertion.count});`;
  return null;
}

export function renderRecordedReplay(records, spec) {
  const lines = [
    "// Generated from a successful agent run. Semantic YAML remains the source of truth.",
    "export default async function replay({ page, expect, checkpoint, target, value, baseURL }) {",
  ];
  const covered = new Set();
  for (const record of records) {
    if (record.type === "action") {
      const line = renderRecordedAction(record.replay);
      if (line) lines.push(`  ${line}`);
    } else {
      const line = renderRecordedAssertion(record.replay);
      if (line && Number.isInteger(record.stepIndex) && Number.isInteger(record.expectationIndex)) {
        covered.add(`${record.stepIndex}:${record.expectationIndex}`);
        lines.push(`  await checkpoint(${record.stepIndex}, ${record.expectationIndex}, async () => { ${line} });`);
      }
    }
  }
  lines.push("}", "");
  const total = spec.steps.reduce((sum, step) => sum + step.expect.length, 0);
  return { script: lines.join("\n"), coverage: { deterministic: covered.size, total, complete: covered.size === total } };
}

export function createReplayRecorder(executor) {
  const records = [];
  const expectationIndexes = new Map();
  if (!executor) return { executor, records };
  const wrapped = new Proxy(executor, {
    get(target, property, receiver) {
      if (property === "act" || property === "recover") {
        return async (...args) => {
          const response = await target[property](...args);
          const context = args.at(-1) ?? {};
          if (response?.replay?.action && !new Set(["failed", "blocked"]).has(response.status)) {
            records.push({ type: "action", replay: response.replay.action, stepIndex: context.stepIndex });
          }
          return response;
        };
      }
      if (property === "observe" || property === "waitFor") {
        return async (...args) => {
          const response = await target[property](...args);
          const context = args.at(-1) ?? {};
          const key = `${context.scope}:${context.stepIndex ?? context.fixtureId}:${property}`;
          const expectationIndex = expectationIndexes.get(key) ?? 0;
          expectationIndexes.set(key, expectationIndex + 1);
          if (response?.replay?.assertion && (response.status === "passed" || response.passed === true)) {
            records.push({ type: "assertion", replay: response.replay.assertion, stepIndex: context.stepIndex, expectationIndex });
          }
          return response;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { executor: wrapped, records };
}

export function createReplayManifest({ specId, environment, sourceHash, script, coverage, state = "candidate", now = new Date() }) {
  return {
    version: 1,
    specId,
    environment,
    state,
    sourceHash,
    scriptHash: replayHash(script),
    generatorVersion: REPLAY_GENERATOR_VERSION,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    coverage,
    validation: { required: REPLAY_VALIDATION_RUNS, passed: 0 },
  };
}

export async function replayStatus(workspace, specId, environmentId) {
  const source = await replaySource(workspace, specId, environmentId);
  let manifest;
  let script;
  try {
    [manifest, script] = await Promise.all([workspace.loadReplayManifest(specId), workspace.readReplayScript(specId)]);
  } catch (error) {
    if (error instanceof QaError && error.code === "NOT_FOUND") return { state: "missing", source };
    throw error;
  }
  const scriptHash = replayHash(script);
  if (manifest.sourceHash !== source.sourceHash || manifest.environment !== (environmentId ?? source.spec.environment)) {
    return { state: "stale", source, manifest, script, scriptHash };
  }
  if (manifest.scriptHash !== scriptHash) return { state: "edited", source, manifest, script, scriptHash };
  return { state: manifest.state, source, manifest, script, scriptHash };
}

function locatorFor(page, candidate) {
  if (candidate.strategy === "role") return page.getByRole(...candidate.value);
  if (candidate.strategy === "label") return page.getByLabel(candidate.value, { exact: true });
  if (candidate.strategy === "text") return page.getByText(candidate.value, { exact: true });
  if (candidate.strategy === "testid") return page.getByTestId(candidate.value);
  if (candidate.strategy === "css") return page.locator(candidate.value);
  throw new QaError("INVALID_REPLAY_LOCATOR", `Unsupported locator strategy: ${candidate.strategy}`);
}

async function launchDefault(channel) {
  const playwright = await import("playwright-core");
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new QaError("PLAYWRIGHT_UNAVAILABLE", "Bundled Playwright did not expose Chromium");
  return chromium.launch({ channel, headless: true });
}

async function launchBrowser(launcher, requestedChannel) {
  const channels = requestedChannel ? [requestedChannel] : ["chrome", "msedge"];
  let lastError;
  for (const channel of channels) {
    try {
      return { browser: await launcher(channel), channel };
    } catch (error) {
      lastError = error;
    }
  }
  throw new QaError("PLAYWRIGHT_UNAVAILABLE", `No supported Chrome-family browser is available: ${lastError?.message ?? "launch failed"}`);
}

export async function runReplayAttempt(options = {}) {
  const { workspace, specId, environmentId, variables = process.env, browserLauncher = launchDefault, validation = false } = options;
  const started = new Date();
  let status;
  let launched;
  let prepared;
  const consoleErrors = [];
  const networkErrors = [];
  const covered = new Set();
  let context;
  try {
    status = await replayStatus(workspace, specId, environmentId);
    if (!status.script) return { engine: "playwright", status: "skipped", reason: `Replay is ${status.state}`, startedAt: started.toISOString(), completedAt: new Date().toISOString(), durationMs: 0, validation };
    validateReplayScriptSource(status.script);
    prepared = await prepareEnvironment(status.source.environment, {
      repositoryRoot: workspace.repositoryRoot,
      fetchImpl: options.fetchImpl,
      startApplication: options.startApplication,
      startupTimeoutMs: options.startupTimeoutMs,
      signal: options.signal,
    });
    launched = await launchBrowser(browserLauncher, variables.QA_PLAYWRIGHT_BROWSER_CHANNEL);
    context = await launched.browser.newContext();
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => networkErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
    const target = async (candidates) => {
      for (const candidate of candidates) {
        const locator = locatorFor(page, candidate);
        if (await locator.count() === 1) return locator;
      }
      throw new QaError("REPLAY_TARGET_MISSING", `No unique target matched ${JSON.stringify(candidates)}`);
    };
    const checkpoint = async (stepIndex, expectationIndex, assertion) => {
      const key = `${stepIndex}:${expectationIndex}`;
      if (covered.has(key)) throw new QaError("DUPLICATE_REPLAY_CHECK", `Replay checked ${key} more than once`);
      await assertion();
      covered.add(key);
    };
    const value = (reference) => {
      const match = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(reference);
      if (!match) return String(reference);
      if (variables[match[1]] === undefined) throw new QaError("MISSING_REFERENCE", `Missing replay input: ${match[1]}`);
      return String(variables[match[1]]);
    };
    const moduleUrl = `${pathToFileURL(workspace.replayScriptPath(specId)).href}?hash=${status.scriptHash}`;
    const replay = (await import(moduleUrl)).default;
    if (typeof replay !== "function") throw new QaError("INVALID_REPLAY_SCRIPT", "Replay default export is not a function");
    const playwrightTest = options.expectImpl ? null : await import("@playwright/test");
    const expect = options.expectImpl ?? playwrightTest.expect ?? playwrightTest.default?.expect;
    if (!expect) throw new QaError("PLAYWRIGHT_UNAVAILABLE", "Bundled Playwright did not expose expect");
    await replay({ page, expect, checkpoint, target, value, baseURL: prepared.target.baseUrl });
    const expected = new Set(status.source.spec.steps.flatMap((step, stepIndex) => (
      step.expect.map((_expectation, expectationIndex) => `${stepIndex + 1}:${expectationIndex}`)
    )));
    const missing = [...expected].filter((key) => !covered.has(key));
    const unexpected = [...covered].filter((key) => !expected.has(key));
    if (covered.size !== status.manifest.coverage.total || missing.length > 0 || unexpected.length > 0 || !status.manifest.coverage.complete) {
      throw new QaError("INCOMPLETE_REPLAY_COVERAGE", `Replay checked ${covered.size}/${status.manifest.coverage.total} expectations; checkpoint mismatch: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`);
    }
    const completed = new Date();
    return { engine: "playwright", status: "passed", startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed - started, browserChannel: launched.channel, validation, consoleErrors, networkErrors };
  } catch (error) {
    const completed = new Date();
    return { engine: "playwright", status: "failed", reason: error instanceof Error ? error.message : String(error), startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed - started, ...(launched?.channel ? { browserChannel: launched.channel } : {}), validation, consoleErrors, networkErrors };
  } finally {
    await context?.close().catch(() => {});
    await launched?.browser.close().catch(() => {});
    await prepared?.startedApplication?.stop?.().catch(() => {});
  }
}

export function replayPromotionSafe(spec, fixtures = []) {
  if (!spec.steps.some((step) => DESTRUCTIVE_INTENT.test(step.intent))) return true;
  return (spec.fixtures?.after?.length ?? 0) > 0 && fixtures.length > 0 && fixtures.every((fixture) => fixture.idempotent === true);
}

export async function validateReplayCandidate(options) {
  const { workspace, specId, environmentId } = options;
  const status = await replayStatus(workspace, specId, environmentId);
  if (!status.script || !status.manifest) throw new QaError("REPLAY_NOT_FOUND", `No replay candidate exists for ${specId}`);
  if (status.state === "stale") throw new QaError("STALE_REPLAY", `Replay source changed for ${specId}; run the agent to regenerate it`);
  const candidate = { ...status.manifest, state: "candidate", scriptHash: status.scriptHash, validation: { required: REPLAY_VALIDATION_RUNS, passed: 0 } };
  await workspace.saveReplayManifest(specId, candidate);
  const attempts = [];
  for (let index = 0; index < REPLAY_VALIDATION_RUNS; index += 1) {
    const attempt = await runReplayAttempt({ ...options, validation: true });
    attempts.push(attempt);
    if (attempt.status !== "passed") {
      const rejected = { ...candidate, state: "rejected", lastFailure: attempt.reason ?? "Replay validation failed", validation: { required: REPLAY_VALIDATION_RUNS, passed: index } };
      await workspace.saveReplayManifest(specId, rejected);
      return { trusted: false, manifest: rejected, attempts };
    }
  }
  const trusted = { ...candidate, state: "trusted", browserChannel: attempts.at(-1).browserChannel, validatedAt: new Date().toISOString(), validation: { required: REPLAY_VALIDATION_RUNS, passed: REPLAY_VALIDATION_RUNS } };
  await workspace.saveReplayManifest(specId, trusted);
  return { trusted: true, manifest: trusted, attempts };
}

function fastResult({ spec, environmentId, attempt, manifest }) {
  const runId = createRunId(new Date(attempt.startedAt));
  const events = [
    { sequence: 1, at: attempt.startedAt, type: "run_started", message: `Running ${spec.id}` },
    { sequence: 2, at: attempt.startedAt, type: "playwright_started", phase: "test", message: "Running trusted Playwright replay" },
    { sequence: 3, at: attempt.completedAt, type: "playwright_completed", phase: "test", status: "passed", message: "Trusted Playwright replay passed" },
    { sequence: 4, at: attempt.completedAt, type: "run_completed", status: "passed", message: "All declared expectations passed through Playwright" },
  ];
  return {
    version: 1,
    runId,
    specId: spec.id,
    environment: environmentId,
    classification: "passed",
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    explanation: "All declared expectations passed through the trusted Playwright replay",
    steps: spec.steps.map((step, index) => ({
      index: index + 1,
      intent: step.intent,
      ...(step.channel ? { channel: step.channel } : {}),
      status: "passed",
      expectations: step.expect.map((expectation) => ({ expectation, status: "passed", observation: "Verified by Playwright" })),
    })),
    fixtures: fixtureOccurrences(spec).map(({ fixtureId, phase }) => ({ fixtureId, phase, status: "passed", explanation: "Verified by Playwright replay" })),
    evidence: { screenshots: [], consoleErrors: attempt.consoleErrors, networkErrors: attempt.networkErrors, unsupported: [] },
    execution: {
      mode: "playwright",
      agentCalls: 0,
      attempts: [attempt],
      script: { path: `.qa/specs/${spec.id}.playwright.mjs`, state: "trusted", sourceHash: manifest.sourceHash, scriptHash: manifest.scriptHash, validationRuns: manifest.validation.passed },
    },
    events,
  };
}

async function preserveRejectedScript(workspace, result, specId) {
  try {
    const source = workspace.replayScriptPath(specId);
    const directory = path.dirname(workspace.resultPath(result.runId));
    await mkdir(directory, { recursive: true });
    await copyFile(source, path.join(directory, `${specId}.rejected.playwright.mjs`));
  } catch {}
}

export async function executeWithReplay(options) {
  const { workspace, specId } = options;
  const source = await replaySource(workspace, specId, options.environmentId);
  const environmentId = options.environmentId ?? source.spec.environment;
  const initial = await replayStatus(workspace, specId, environmentId);
  const attempts = [];
  let fastAttempt;
  let manifest = initial.manifest;
  const fullyBrowserDeterministic = !source.spec.design && source.spec.steps.every((step) => (step.channel ?? "web") === "web");

  if (initial.state === "edited") {
    const validation = await validateReplayCandidate(options);
    attempts.push(...validation.attempts);
    manifest = validation.manifest;
    if (validation.trusted && fullyBrowserDeterministic) {
      const result = fastResult({ spec: source.spec, environmentId, attempt: validation.attempts.at(-1), manifest });
      result.startedAt = validation.attempts[0].startedAt;
      result.execution.attempts = validation.attempts;
      await workspace.saveResult(result, { select: options.selectResult !== false });
      return result;
    }
  } else if (initial.state === "trusted") {
    fastAttempt = await runReplayAttempt(options);
    attempts.push(fastAttempt);
    if (fastAttempt.status === "passed" && fullyBrowserDeterministic) {
      const result = fastResult({ spec: source.spec, environmentId, attempt: fastAttempt, manifest });
      await workspace.saveResult(result, { select: options.selectResult !== false });
      return result;
    }
    if (fastAttempt.status === "failed") {
      manifest = { ...manifest, state: "rejected", lastFailure: fastAttempt.reason };
      await workspace.saveReplayManifest(specId, manifest);
    }
  } else {
    const now = new Date().toISOString();
    attempts.push({ engine: "playwright", status: "skipped", startedAt: now, completedAt: now, durationMs: 0, reason: `Replay is ${initial.state}` });
  }

  const nativeExecutor = typeof options.executorFactory === "function"
    ? await options.executorFactory({ spec: source.spec, environment: source.environment, environmentId })
    : options.executor;
  const recorder = createReplayRecorder(nativeExecutor);
  const agentStarted = new Date();
  const result = await executeRun({ ...options, environmentId, executor: recorder.executor });
  const agentCompleted = new Date();
  const agentAttempt = {
    engine: "agent",
    status: new Set(["passed", "healed"]).has(result.classification) ? "passed" : result.classification === "blocked" ? "blocked" : "failed",
    startedAt: agentStarted.toISOString(),
    completedAt: agentCompleted.toISOString(),
    durationMs: agentCompleted - agentStarted,
  };
  attempts.push(agentAttempt);
  const fallbackReason = fastAttempt?.reason ?? (initial.state === "trusted" ? "Replay requires hybrid checks" : `Replay is ${initial.state}`);
  result.execution = {
    mode: fastAttempt?.status === "passed" ? "hybrid" : fastAttempt?.status === "failed" ? "agent_fallback" : "agent",
    agentCalls: nativeExecutor ? 1 : 0,
    fallbackReason,
    attempts,
    ...(manifest ? { script: { path: `.qa/specs/${specId}.playwright.mjs`, state: manifest.state, sourceHash: manifest.sourceHash, scriptHash: manifest.scriptHash, validationRuns: manifest.validation.passed } } : {}),
  };
  if (fastAttempt) {
    const completedEvent = result.events?.findLast((event) => event.type === "run_completed");
    const body = (result.events ?? []).filter((event) => event !== completedEvent);
    result.events = [
      { sequence: 1, at: agentStarted.toISOString(), type: "agent_fallback_started", phase: "run", message: fallbackReason },
      ...body,
      { sequence: 0, at: agentCompleted.toISOString(), type: "agent_fallback_completed", phase: "run", status: agentAttempt.status, message: result.explanation },
      ...(completedEvent ? [completedEvent] : []),
    ].map((event, index) => ({ ...event, sequence: index + 1 }));
  }

  if (new Set(["passed", "healed"]).has(result.classification)) {
    let candidate;
    if (recorder.records.length > 0) candidate = renderRecordedReplay(recorder.records, source.spec);
    else if (initial.state === "candidate" && initial.script) candidate = { script: initial.script, coverage: initial.manifest.coverage };
    if (candidate?.coverage.complete && replayPromotionSafe(source.spec, source.fixtures)) {
      await preserveRejectedScript(workspace, result, specId);
      const nextManifest = createReplayManifest({ specId, environment: environmentId, sourceHash: source.sourceHash, script: candidate.script, coverage: candidate.coverage });
      await workspace.saveReplayArtifacts(specId, validateReplayScriptSource(candidate.script), nextManifest);
      const validation = await validateReplayCandidate(options);
      result.execution.attempts.push(...validation.attempts);
      result.execution.script = { path: `.qa/specs/${specId}.playwright.mjs`, state: validation.manifest.state, sourceHash: validation.manifest.sourceHash, scriptHash: validation.manifest.scriptHash, validationRuns: validation.manifest.validation.passed };
    }
  }
  result.completedAt = new Date().toISOString();
  const completedEvent = result.events?.findLast((event) => event.type === "run_completed");
  if (completedEvent) completedEvent.at = result.completedAt;
  await workspace.saveResult(result, { select: options.selectResult !== false });
  return result;
}
