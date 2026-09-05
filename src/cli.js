import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { draftSpec } from "./draft.js";
import { parseJson, stringifyJson, stringifyYaml } from "./documents.js";
import { formatQaError, QaError } from "./errors.js";
import { executeRun } from "./execution.js";
import { atomicWriteFile, QaWorkspace } from "./storage.js";

const HELP = `qa-agent — semantic QA workspace and native execution runtime

Usage:
  qa-agent init [--empty] [--root <repository>]
  qa-agent create <requirement> [--id <id>] [--env <id>] [--expect <text>]...
  qa-agent spec <list|show|validate|save|delete> [id|file]
  qa-agent fixture <list|show|validate|save|delete> [id|file]
  qa-agent environment <list|show|validate|save> [id|file]
  qa-agent result <list|show|validate|save|delete> [run-id|file]
  qa-agent run <spec-id> [--env <id>]
  qa-agent run-last
  qa-agent select <spec-id> [--env <id>]
  qa-agent last
  qa-agent edit <spec-id>
  qa-agent validate

Use '-' as a save/validate file to read from standard input. All writes are
validated and atomically replace the destination file.`;

async function runCommand(workspace, specId, environmentId, io, output) {
  const result = await executeRun({
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
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const result = spawnSync(editor, [stagingPath], { stdio: "inherit", shell: false });
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

async function resultCommand(workspace, args, output) {
  const action = args.shift();
  if (action === "list") {
    printList(await workspace.listResults(), ["runId", "classification", "specId", "environment"], output);
    return;
  }
  if (action === "show") {
    output(stringifyJson(await workspace.loadResult(args[0])));
    return;
  }
  if (action === "validate") {
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

    if (command === "create") {
      const id = option(args, "--id");
      const environment = option(args, "--env");
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
      const spec = draftSpec(requirement, { id, environment, expectations, beforeFixtures: inferredFixtures });
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
