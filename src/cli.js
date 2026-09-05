import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { draftSpec } from "./draft.js";
import { parseJson, stringifyJson, stringifyYaml } from "./documents.js";
import { formatQaError, QaError } from "./errors.js";
import { executeWithReplay, replayStatus, validateReplayCandidate } from "./replay.js";
import { createHistoryRequest, resolveHistory } from "./history.js";
import { atomicWriteFile, QaWorkspace } from "./storage.js";
import { startQaUi } from "./ui-server.js";

const HELP = `qa-agent — semantic QA workspace and native execution runtime

Usage:
  qa-agent init [--empty] [--root <repository>]
  qa-agent setup --type <web|desktop> [--environment <id>] [--base-url <url>]
                 [--start-command <command>] [--app <application>]
  qa-agent create <requirement> [--id <id>] [--env <id>] [--expect <text>]... [--channel <web|chat|voice|workflow|api>]
  qa-agent orchestrate --url <url> [--username <u>] [--password <p>] [--prompt <text>] [--prd <file>]
                       [--plan <file>] [--plan-only] [--out <dir>] [--max-replans <n>] [--concurrency <n>]
                       [--planning-concurrency <n>] [--crawl-concurrency <n>] [--no-history] [--app-revision <id>] [--allow-remote] [--json]
  qa-agent history query --url <url> --prompt <text> [--authenticated] [--app-revision <id>]
  qa-agent spec <list|show|validate|save|delete> [id|file]
  qa-agent fixture <list|show|validate|save|delete> [id|file]
  qa-agent environment <list|show|validate|save> [id|file]
  qa-agent result <list|show|validate|save|delete> [run-id|file]
  qa-agent replay <status|validate> <spec-id> [--env <id>]
  qa-agent run <spec-id> [--env <id>]
  qa-agent run-last
  qa-agent audit <run-id>
  qa-agent ui [--host <loopback-host>] [--port <port>]
  qa-agent select <spec-id> [--env <id>]
  qa-agent last
  qa-agent edit <spec-id>
  qa-agent validate

Use '-' as a save/validate file to read from standard input. All writes are
validated and atomically replace the destination file.`;

async function runCommand(workspace, specId, environmentId, io, output) {
  const result = await executeWithReplay({
    workspace,
    specId,
    environmentId,
    executor: io.nativeExecutor,
    variables: io.variables ?? process.env,
    signal: io.signal,
    fetchImpl: io.fetchImpl,
    startApplication: io.startApplication,
    startupTimeoutMs: io.startupTimeoutMs,
    clock: io.clock,
    onEvent: io.onEvent ?? ((event) => {
      const subject = event.fixtureId ?? (event.stepIndex ? `step ${event.stepIndex}` : "");
      output([event.type, subject, event.status].filter(Boolean).join("\t"));
    }),
    browserLauncher: io.browserLauncher,
    expectImpl: io.expectImpl,
  });
  output(`${result.runId}\t${result.classification}\t${result.explanation}`);
  output(`Saved .qa/runs/${result.runId}/result.json`);
  return new Set(["passed", "healed"]).has(result.classification) ? 0 : 1;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (index === args.length - 1 || args[index + 1].startsWith("--")) {
    throw new QaError("MISSING_OPTION_VALUE", `${name} requires a value`);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function options(args, name) {
  const values = [];
  let value;
  while ((value = option(args, name)) !== undefined) values.push(value);
  return values;
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function assertNoUnknownOptions(args) {
  const unknown = args.find((value) => value.startsWith("--"));
  if (unknown) throw new QaError("UNKNOWN_OPTION", `Unknown option: ${unknown}`);
}

function plannerDraftFromFile(value) {
  const isNormalizedPlan = value?.version === 1
    && typeof value?.id === "string"
    && typeof value?.target === "string"
    && Array.isArray(value?.flows);
  if (!isNormalizedPlan) return value;
  const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
  return {
    flows: value.flows.map((flow) => ({
      ...pick(flow, ["id", "title", "category", "priority", "rationale", "pages", "preconditions", "risks", "requirementIds"]),
      steps: (flow.steps ?? []).map((step) => ({
        ...pick(step, ["intent", "page", "action", "channel", "inputs"]),
        ...(step.expect ? {
          expect: step.expect.map((expectation) => typeof expectation === "string" ? { prose: expectation } : expectation),
        } : {}),
      })),
    })),
    ...(Array.isArray(value.openQuestions) ? { openQuestions: value.openQuestions } : {}),
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
  };
}

async function input(fileName) {
  try {
    return await readFile(fileName === "-" ? 0 : path.resolve(fileName), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new QaError("NOT_FOUND", `Input file does not exist: ${fileName}`);
    throw error;
  }
}

function printList(items, fields, output) {
  if (items.length === 0) {
    output("No entries found.");
    return;
  }
  for (const item of items) output(fields.map((field) => item[field]).filter(Boolean).join("\t"));
}

async function editSpec(workspace, id) {
  const spec = await workspace.loadSpec(id);
  const stagingPath = path.join(workspace.specsDirectory, `.${id}.edit-${process.pid}.yaml`);
  await atomicWriteFile(stagingPath, stringifyYaml(spec));
  try {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
    // Most Windows editors are `.cmd`/`.bat` shims, which Node refuses to spawn
    // without a shell (CVE-2024-27980). The editor is the developer's own
    // configured command, so deferring to the shell there is the same trust
    // boundary git and npm use.
    const result = spawnSync(editor, [stagingPath], { stdio: "inherit", shell: process.platform === "win32" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new QaError("EDITOR_FAILED", `${editor} exited with status ${result.status}`);
    return await workspace.saveSpec(await readFile(stagingPath, "utf8"));
  } finally {
    await unlink(stagingPath).catch(() => {});
  }
}

async function specCommand(workspace, args, output) {
  const action = args.shift();
  if (action === "list") {
    printList(await workspace.listSpecs(), ["id", "environment", "title"], output);
    return;
  }
  if (action === "show") {
    output(stringifyYaml(await workspace.loadSpec(args[0])));
    return;
  }
  if (action === "validate") {
    const target = args[0];
    if (!target) throw new QaError("MISSING_ARGUMENT", "spec validate requires an ID or YAML file");
    const value = target.endsWith(".yaml") || target === "-"
      ? await workspace.validateSpec(await input(target), `Spec ${target}`)
      : await workspace.loadSpec(target);
    output(`Valid spec: ${value.id}`);
    return;
  }
  if (action === "save") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "spec save requires a YAML file or '-'");
    const value = await workspace.saveSpec(await input(args[0]));
    output(`Saved .qa/specs/${value.id}.yaml`);
    return;
  }
  if (action === "delete") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "spec delete requires an ID");
    await workspace.deleteSpec(args[0]);
    output(`Deleted spec ${args[0]}`);
    return;
  }
  throw new QaError("UNKNOWN_COMMAND", `Unknown spec operation: ${action ?? "(missing)"}`);
}

async function fixtureCommand(workspace, args, output) {
  const action = args.shift();
  if (action === "list") {
    printList(await workspace.listFixtures(), ["id", "title"], output);
    return;
  }
  if (action === "show") {
    output(stringifyYaml(await workspace.loadFixture(args[0])));
    return;
  }
  if (action === "validate") {
    const target = args[0];
    if (!target) throw new QaError("MISSING_ARGUMENT", "fixture validate requires an ID or YAML file");
    const value = target.endsWith(".yaml") || target === "-"
      ? workspace.validateFixture(await input(target), `Fixture ${target}`)
      : await workspace.loadFixture(target);
    output(`Valid fixture: ${value.id}`);
    return;
  }
  if (action === "save") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "fixture save requires a YAML file or '-'");
    const value = await workspace.saveFixture(await input(args[0]));
    output(`Saved .qa/fixtures/${value.id}.yaml`);
    return;
  }
  if (action === "delete") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "fixture delete requires an ID");
    await workspace.deleteFixture(args[0]);
    output(`Deleted fixture ${args[0]}`);
    return;
  }
  throw new QaError("UNKNOWN_COMMAND", `Unknown fixture operation: ${action ?? "(missing)"}`);
}

async function environmentCommand(workspace, args, output) {
  const action = args.shift();
  if (action === "list") {
    printList(await workspace.listEnvironments(), ["id", "type", "baseUrl", "app"], output);
    return;
  }
  if (action === "show") {
    const environments = await workspace.loadEnvironments();
    const id = args[0];
    if (!Object.hasOwn(environments.environments, id)) {
      throw new QaError("UNKNOWN_ENVIRONMENT", `Unknown environment: ${id}`);
    }
    output(stringifyYaml({ version: 1, environments: { [id]: environments.environments[id] } }));
    return;
  }
  if (action === "validate") {
    const value = args[0]
      ? workspace.validateEnvironments(await input(args[0]))
      : await workspace.loadEnvironments();
    output(`Valid environments: ${Object.keys(value.environments).length}`);
    return;
  }
  if (action === "save") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "environment save requires a YAML file or '-'");
    const value = await workspace.saveEnvironments(await input(args[0]));
    output(`Saved ${Object.keys(value.environments).length} environments`);
    return;
  }
  throw new QaError("UNKNOWN_COMMAND", `Unknown environment operation: ${action ?? "(missing)"}`);
}

async function setupCommand(workspace, args, output) {
  const type = option(args, "--type");
  const environmentId = option(args, "--environment") ?? "local";
  const baseUrl = option(args, "--base-url");
  const startCommand = option(args, "--start-command");
  const app = option(args, "--app");
  assertNoUnknownOptions(args);
  if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected setup argument: ${args[0]}`);
  if (!type) throw new QaError("MISSING_OPTION_VALUE", "setup requires --type web or --type desktop");

  let target;
  if (type === "web") {
    if (!baseUrl) throw new QaError("MISSING_OPTION_VALUE", "web setup requires --base-url");
    if (app) throw new QaError("INVALID_SETUP_OPTION", "--app is only valid for desktop setup");
    target = { type, baseUrl, ...(startCommand ? { startCommand } : {}) };
  } else if (type === "desktop") {
    if (!app) throw new QaError("MISSING_OPTION_VALUE", "desktop setup requires --app");
    if (baseUrl || startCommand) {
      throw new QaError("INVALID_SETUP_OPTION", "--base-url and --start-command are only valid for web setup");
    }
    target = { type, app };
  } else {
    throw new QaError("INVALID_ENVIRONMENT_TYPE", "--type must be web or desktop");
  }

  await workspace.ensureDirectories();
  let environments;
  try {
    environments = await workspace.loadEnvironments();
  } catch (error) {
    if (!(error instanceof QaError) || error.code !== "NOT_FOUND") throw error;
    environments = { version: 1, environments: {} };
  }

  const existing = environments.environments[environmentId];
  if (existing && JSON.stringify(existing) !== JSON.stringify(target)) {
    throw new QaError(
      "ENVIRONMENT_EXISTS",
      `Environment ${environmentId} already exists with different settings; edit .qa/environments.yaml explicitly`,
    );
  }

  if (!existing) {
    environments.environments[environmentId] = target;
    await workspace.saveEnvironments(environments);
    output(`Created environment ${environmentId}`);
  } else {
    output(`Kept existing environment ${environmentId}`);
  }
  output(`QA workspace is ready at ${workspace.qaDirectory}`);
}

async function resultCommand(workspace, args, output) {
  const action = args.shift();
  if (action === "list") {
    printList(await workspace.listResults(), ["runId", "classification", "specId", "environment"], output);
    return;
  }
  if (action === "show") {
    output(stringifyJson(await workspace.loadResult(args[0])));
    return;
  }  if (action === "validate") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "result validate requires a JSON file or '-'");
    const value = workspace.validateResult(await input(args[0]));
    output(`Valid result: ${value.runId}`);
    return;
  }
  if (action === "save") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "result save requires a JSON file or '-'");
    const value = await workspace.saveResult(await input(args[0]));
    output(`Saved .qa/runs/${value.runId}/result.json`);
    return;
  }
  if (action === "delete") {
    if (!args[0]) throw new QaError("MISSING_ARGUMENT", "result delete requires a run ID");
    await workspace.deleteResult(args[0]);
    output(`Deleted result ${args[0]}`);
    return;
  }
  throw new QaError("UNKNOWN_COMMAND", `Unknown result operation: ${action ?? "(missing)"}`);
}

async function replayCommand(workspace, args, io, output) {
  const action = args.shift();
  const id = args.shift();
  const environmentId = option(args, "--env");
  if (!id) throw new QaError("MISSING_ARGUMENT", `replay ${action ?? "operation"} requires a spec ID`);
  assertNoUnknownOptions(args);
  if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected replay argument: ${args[0]}`);
  if (action === "status") {
    const status = await replayStatus(workspace, id, environmentId);
    output(stringifyJson({ state: status.state, ...(status.manifest ? { manifest: status.manifest } : {}) }));
    return 0;
  }
  if (action === "validate") {
    const result = await validateReplayCandidate({
      workspace,
      specId: id,
      environmentId,
      variables: io.variables ?? process.env,
      browserLauncher: io.browserLauncher,
      expectImpl: io.expectImpl,
      fetchImpl: io.fetchImpl,
      startApplication: io.startApplication,
      startupTimeoutMs: io.startupTimeoutMs,
      signal: io.signal,
    });
    output(stringifyJson({ trusted: result.trusted, manifest: result.manifest, attempts: result.attempts }));
    return result.trusted ? 0 : 1;
  }
  throw new QaError("UNKNOWN_COMMAND", `Unknown replay operation: ${action ?? "(missing)"}`);
}

async function historyCommand(workspace, args, output) {
  const action = args.shift();
  if (action !== "query") throw new QaError("UNKNOWN_COMMAND", `Unknown history operation: ${action ?? "(missing)"}`);
  const url = option(args, "--url");
  const prompt = option(args, "--prompt") ?? "";
  const appRevisionOption = option(args, "--app-revision") ?? "auto";
  const authenticated = flag(args, "--authenticated");
  assertNoUnknownOptions(args);
  if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected history argument: ${args[0]}`);
  if (!url) throw new QaError("MISSING_OPTION_VALUE", "history query requires --url");
  const { resolveApplicationRevision } = await import("./orchestrator.js");
  const appRevision = await resolveApplicationRevision(workspace.repositoryRoot, appRevisionOption);
  const request = createHistoryRequest({ target: url, prompt, authScope: authenticated ? "authenticated" : "anonymous", appRevision });
  const result = await resolveHistory({ workspace, request });
  const candidates = result.kind === "exact"
    ? result.replay.map((entry) => ({ specId: entry.specId, replayState: entry.state, sourceHash: entry.sourceHash, scriptHash: entry.scriptHash, requiredVariables: entry.requiredVariables, score: 1 }))
    : result.candidates ?? [];
  const recommended = candidates.find((candidate) => candidate.replayState === "trusted"
    && candidate.score >= 0.35
    && (result.kind === "exact" || new Set(["passed", "healed"]).has(candidate.lastClassification)));
  output(stringifyJson({
    version: 1,
    kind: result.kind,
    fingerprint: request.fingerprint,
    ...(result.kind === "exact" ? { sourceOrchestrationId: result.manifest.orchestrationId } : {}),
    candidates,
    ...(recommended ? { recommendedSpecId: recommended.specId, reason: result.kind === "exact" ? "exact compatible orchestration with trusted replay" : "same-origin source-matched trusted replay with sufficient semantic overlap and a prior clean outcome" } : {}),
  }));
  return 0;
}

export function auditResult({ spec, result }) {
  const checks = [];
  const push = (name, passed, detail) => checks.push({ name, passed, ...(detail ? { detail } : {}) });

  const classifications = new Set(["passed", "healed", "functional_regression", "design_regression", "blocked"]);
  push("classification is known", classifications.has(result.classification), result.classification);

  const specSteps = new Map(spec.steps.map((step) => [step.index ?? spec.steps.indexOf(step) + 1, step]));
  let expectationsIntact = true;
  let channelsIntact = true;
  for (const step of result.steps ?? []) {
    const specStep = spec.steps[(step.index ?? 1) - 1];
    if (!specStep) {
      expectationsIntact = false;
      channelsIntact = false;
      continue;
    }
    const recorded = (step.expectations ?? []).map((entry) => entry.expectation);
    if (JSON.stringify(recorded) !== JSON.stringify(specStep.expect)) expectationsIntact = false;
    if ((step.channel ?? "web") !== (specStep.channel ?? "web")) channelsIntact = false;
  }
  push("expectations byte-for-byte unchanged", expectationsIntact);
  push("channels unchanged", channelsIntact);

  const healedSteps = (result.steps ?? []).filter((step) => step.healing?.outcome === "healed");
  const healingEvidence = healedSteps.every((step) => Boolean(step.healing.beforeScreenshot) && Boolean(step.healing.afterScreenshot));
  push(
    "healing has before/after evidence",
    healedSteps.length === 0 || healingEvidence,
    healedSteps.length === 0 ? "no healing claimed" : `${healedSteps.length} healed step(s)`,
  );
  if (result.classification === "healed") {
    push("healed classification has recovery", healedSteps.length > 0);
    push("healed run has no failed steps", !(result.steps ?? []).some((step) => step.status !== "passed"));
  }

  if (spec.design) {
    const design = result.design;
    push("declared design check completed", Boolean(design) && design.status !== "not_checked", design?.status ?? "missing");
    if (design?.status === "regression") {
      push(
        "design regression has concrete findings",
        (design.findings ?? []).some((finding) => finding.status === "regression"),
      );
      push("design regression has actual evidence", Boolean(design.actualScreenshot));
    }
  } else {
    push("no undeclared design result", !result.design);
  }

  const screenshots = new Set(result.evidence?.screenshots ?? []);
  const declaredScreenshots = [
    ...healedSteps.flatMap((step) => [step.healing.beforeScreenshot, step.healing.afterScreenshot]),
    ...(result.design?.actualScreenshot ? [result.design.actualScreenshot] : []),
    ...(result.design?.referenceScreenshot ? [result.design.referenceScreenshot] : []),
  ].filter(Boolean);
  push(
    "declared screenshots are in evidence",
    declaredScreenshots.every((name) => screenshots.has(name)),
    `${declaredScreenshots.length} declared`,
  );

  const serialized = JSON.stringify(result);
  push("no resolved secret placeholder leaked", !/\b(QA_CUSTOMER_PASSWORD|QA_STAGING_URL)\s*[:=]/i.test(serialized));

  void specSteps;
  const passed = checks.every((check) => check.passed);
  return { passed, checks };
}

async function auditCommand(workspace, args, output) {
  const runId = args.shift();
  if (!runId) throw new QaError("MISSING_ARGUMENT", "audit requires a run ID");
  assertNoUnknownOptions(args);
  if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected audit argument: ${args[0]}`);
  const result = await workspace.loadResult(runId);
  const spec = await workspace.loadSpec(result.specId);
  const audit = auditResult({ spec, result });
  for (const check of audit.checks) {
    output(`${check.passed ? "PASS" : "FAIL"}\t${check.name}${check.detail ? `\t${check.detail}` : ""}`);
  }
  output(audit.passed ? `Governance audit passed for ${runId}` : `Governance audit failed for ${runId}`);
  return audit.passed ? 0 : 1;
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const output = io.output ?? console.log;
  const errorOutput = io.error ?? console.error;
  const args = [...argv];

  try {
    const root = option(args, "--root") || process.cwd();
    const workspace = new QaWorkspace(root);
    const command = args.shift();

    if (!command || command === "help" || command === "--help" || command === "-h") {
      output(HELP);
      return 0;
    }

    if (command === "init") {
      const seed = !flag(args, "--empty");
      assertNoUnknownOptions(args);
      const result = await workspace.init({ seed });
      output(`Initialized ${workspace.qaDirectory}`);
      output(`Created ${result.created.length}; kept ${result.skipped.length} existing files.`);
      return 0;
    }

    if (command === "setup") {
      await setupCommand(workspace, args, output);
      return 0;
    }

    if (command === "create") {
      const id = option(args, "--id");
      const environment = option(args, "--env");
      const channel = option(args, "--channel");
      const expectations = options(args, "--expect");
      const beforeFixtures = options(args, "--fixture-before");
      assertNoUnknownOptions(args);
      const requirement = args.join(" ");
      await workspace.ensureDirectories();
      let inferredFixtures = beforeFixtures;
      if (inferredFixtures.length === 0 && /logged[ -]?in|authenticated/i.test(requirement)) {
        try {
          await workspace.loadFixture("login-customer");
          inferredFixtures = ["login-customer"];
        } catch (error) {
          if (!(error instanceof QaError) || error.code !== "NOT_FOUND") throw error;
        }
      }
      const spec = draftSpec(requirement, { id, environment, expectations, beforeFixtures: inferredFixtures, channel });
      await workspace.saveSpec(spec);
      await workspace.selectSpec(spec.id, spec.environment);
      output(`Created .qa/specs/${spec.id}.yaml`);
      output(stringifyYaml(spec));
      return 0;
    }

    if (command === "spec") await specCommand(workspace, args, output);
    else if (command === "fixture") await fixtureCommand(workspace, args, output);
    else if (command === "environment") await environmentCommand(workspace, args, output);
    else if (command === "result") await resultCommand(workspace, args, output);
    else if (command === "history") return await historyCommand(workspace, args, output);
    else if (command === "replay") return await replayCommand(workspace, args, io, output);
    else if (command === "ui") {
      const host = option(args, "--host");
      const portValue = option(args, "--port");
      const port = portValue === undefined ? undefined : Number(portValue);
      if (portValue !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
        throw new QaError("INVALID_UI_PORT", "--port must be an integer from 0 to 65535");
      }
      assertNoUnknownOptions(args);
      if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected UI argument: ${args[0]}`);
      await workspace.validateAll();
      const application = await (io.startUi ?? startQaUi)({ workspace, host, port });
      output(`QA workspace UI is ready at ${application.url}`);
      output("Press Ctrl+C to stop it.");
    }
    else if (command === "run") {
      const environment = option(args, "--env");
      const id = args.shift();
      if (!id) throw new QaError("MISSING_ARGUMENT", "run requires a spec ID");
      assertNoUnknownOptions(args);
      if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected run argument: ${args[0]}`);
      return await runCommand(workspace, id, environment, io, output);
    } else if (command === "run-last") {
      assertNoUnknownOptions(args);
      if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected run-last argument: ${args[0]}`);
      const selected = await workspace.readLastTest();
      return await runCommand(workspace, selected.specId, selected.environment, io, output);
    } else if (command === "audit") {
      return await auditCommand(workspace, args, output);
    } else if (command === "orchestrate") {
      const { orchestrate } = await import("./orchestrator.js");
      const { readFile: readPrdFile } = await import("node:fs/promises");
      const url = option(args, "--url");
      const username = option(args, "--username") ?? process.env.QA_USERNAME;
      const password = option(args, "--password") ?? process.env.QA_PASSWORD;
      const prompt = option(args, "--prompt") ?? "";
      const prdPath = option(args, "--prd");
      const outDir = option(args, "--out");
      const maxReplansValue = option(args, "--max-replans");
      const concurrencyValue = option(args, "--concurrency");
      const planningConcurrencyValue = option(args, "--planning-concurrency");
      const crawlConcurrencyValue = option(args, "--crawl-concurrency");
      const appRevision = option(args, "--app-revision") ?? "auto";
      const allowRemote = flag(args, "--allow-remote");
      const noHistory = flag(args, "--no-history");
      const json = flag(args, "--json");
      const planOnly = flag(args, "--plan-only");
      // A plan authored by the Planner sub-agent, handed back on disk. The
      // runtime never calls a model itself; this is the file-based half of the
      // same capability `io.planner` provides in process.
      const planPath = option(args, "--plan");
      assertNoUnknownOptions(args);
      if (args.length > 0) throw new QaError("UNKNOWN_ARGUMENT", `Unexpected orchestrate argument: ${args[0]}`);
      if (!url) throw new QaError("MISSING_OPTION_VALUE", "orchestrate requires --url");
      const maxReplans = maxReplansValue === undefined ? 2 : Number(maxReplansValue);
      if (!Number.isInteger(maxReplans) || maxReplans < 1) throw new QaError("INVALID_OPTION_VALUE", "--max-replans must be a positive integer");
      const executionConcurrency = concurrencyValue === undefined ? 3 : Number(concurrencyValue);
      if (!Number.isInteger(executionConcurrency) || executionConcurrency < 1 || executionConcurrency > 8) throw new QaError("INVALID_OPTION_VALUE", "--concurrency must be an integer from 1 to 8");
      const planningConcurrency = planningConcurrencyValue === undefined ? 3 : Number(planningConcurrencyValue);
      if (!Number.isInteger(planningConcurrency) || planningConcurrency < 1 || planningConcurrency > 3) throw new QaError("INVALID_OPTION_VALUE", "--planning-concurrency must be an integer from 1 to 3");
      const crawlConcurrency = crawlConcurrencyValue === undefined ? 4 : Number(crawlConcurrencyValue);
      if (!Number.isInteger(crawlConcurrency) || crawlConcurrency < 1 || crawlConcurrency > 8) throw new QaError("INVALID_OPTION_VALUE", "--crawl-concurrency must be an integer from 1 to 8");
      let prdText;
      if (prdPath) {
        try {
          prdText = await readPrdFile(prdPath, "utf8");
        } catch {
          throw new QaError("INVALID_OPTION_VALUE", `PRD file is unreadable: ${prdPath}`);
        }
      }
      let planner = io.planner;
      if (planPath) {
        let draft;
        try {
          draft = plannerDraftFromFile(parseJson(await readPrdFile(planPath, "utf8")));
        } catch {
          throw new QaError("INVALID_OPTION_VALUE", `Plan draft is unreadable or not JSON: ${planPath}`);
        }
        // A draft on disk is a one-shot answer: the same document every time,
        // so a rejection falls back rather than looping on an unchanging file.
        planner = async () => draft;
      }
      const { report, plan, exitCode, error } = await orchestrate({
        url, username, password, prompt, prdText, outDir, root, maxReplans, allowRemote, planOnly,
        planner, plannerAttempts: planPath ? 1 : 2, planningConcurrency: planPath ? 1 : planningConcurrency, crawlConcurrency,
        executionConcurrency, historyMode: noHistory ? "off" : "lookup", appRevision,
        executor: io.nativeExecutor, executorFactory: io.executorFactory, variables: io.variables ?? process.env, fetchImpl: io.fetchImpl, browserLauncher: io.browserLauncher,
      });
      if (error) throw error;
      if (json) output(JSON.stringify({ exitCode, report, ...(plan ? { plan } : {}) }));
      else {
        const counts = report.summary.scenarios;
        const source = report.planSource ?? plan?.source;
        output(`Orchestration ${report.orchestrationId}: ${report.summary.verdict} (exit ${exitCode})`);
        if (source) {
          output(`Planner: ${source.planner}${source.fellBack ? ` — FELL BACK: ${source.fallbackReason}` : ""}`);
        }
        if (planOnly) output(`Plan only: ${plan?.flows?.length ?? 0} flows · coverage ${report.summary.coverage.score}`);
        else {
          output(`Scenarios ${counts.passed + counts.healed}/${counts.total} clean · ${counts.blocked ?? 0} blocked · ${counts.failed} failed · coverage ${report.summary.coverage.score}`);
        }
        output(`Report: ${report.artifacts.specs} + report.json`);
      }
      return exitCode > 9 ? exitCode : exitCode === 0 ? 0 : 1;
    }
    else if (command === "select") {
      const environment = option(args, "--env");
      const id = args[0];
      if (!id) throw new QaError("MISSING_ARGUMENT", "select requires a spec ID");
      const value = await workspace.selectSpec(id, environment);
      output(`Selected ${value.specId} on ${value.environment}`);
    } else if (command === "last") {
      output(stringifyJson(await workspace.readLastTest()));
    } else if (command === "edit") {
      if (!args[0]) throw new QaError("MISSING_ARGUMENT", "edit requires a spec ID");
      const value = await editSpec(workspace, args[0]);
      output(`Saved .qa/specs/${value.id}.yaml`);
    } else if (command === "validate") {
      const summary = await workspace.validateAll();
      output(`Valid workspace: ${summary.specs} specs, ${summary.fixtures} fixtures, ${summary.environments} environments, ${summary.runs} runs`);
    } else if (command === "list") {
      await specCommand(workspace, ["list", ...args], output);
    } else if (command === "show") {
      await specCommand(workspace, ["show", ...args], output);
    } else {
      throw new QaError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
    }
    return 0;
  } catch (error) {
    errorOutput(formatQaError(error));
    return 1;
  }
}
