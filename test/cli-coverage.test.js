import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { createNativeWebExecutor, QaWorkspace, stringifyJson, stringifyYaml } from "../src/index.js";
import { passingResult } from "../test-support/helpers.js";

function capture(extra = {}) {
  const output = [];
  const errors = [];
  return {
    output,
    errors,
    io: {
      output: (value) => output.push(String(value)),
      error: (value) => errors.push(String(value)),
      ...extra,
    },
  };
}

async function invoke(root, args, extra = {}) {
  const captured = capture(extra);
  captured.exitCode = await runCli([...args, "--root", root], captured.io);
  return captured;
}

test("CLI help, empty initialization, aliases, selection, and workspace validation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = capture();
    assert.equal(await runCli(args, result.io), 0);
    assert.match(result.output[0], /semantic QA workspace/);
  }

  const empty = await invoke(root, ["init", "--empty"]);
  assert.equal(empty.exitCode, 0);
  assert.match((await invoke(root, ["spec", "list"])).output[0], /No entries found/);
  assert.match((await invoke(root, ["fixture", "list"])).output[0], /No entries found/);

  await rm(path.join(root, ".qa"), { recursive: true, force: true });
  assert.equal((await invoke(root, ["init"])).exitCode, 0);
  assert.match((await invoke(root, ["list"])).output.join("\n"), /checkout-card/);
  assert.match((await invoke(root, ["show", "checkout-card"])).output[0], /id: checkout-card/);
  assert.match((await invoke(root, ["last"])).output[0], /"specId": "checkout-card"/);
  assert.match((await invoke(root, ["validate"])).output[0], /Valid workspace/);
  assert.match((await invoke(root, ["select", "checkout-saved-card", "--env", "staging"])).output[0], /staging/);
});

test("CLI document operations cover list, show, validate, save, and guarded delete", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-docs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await invoke(root, ["init"]);
  const workspace = new QaWorkspace(root);

  const fixture = {
    version: 1,
    id: "dismiss-banner",
    title: "Dismiss banner",
    steps: [{ intent: "Dismiss the banner" }],
    expect: ["The banner is absent"],
  };
  const fixtureFile = path.join(root, "dismiss-banner.yaml");
  await writeFile(fixtureFile, stringifyYaml(fixture));
  assert.match((await invoke(root, ["fixture", "validate", fixtureFile])).output[0], /dismiss-banner/);
  assert.match((await invoke(root, ["fixture", "save", fixtureFile])).output[0], /Saved/);
  assert.match((await invoke(root, ["fixture", "validate", fixture.id])).output[0], /dismiss-banner/);
  assert.match((await invoke(root, ["fixture", "show", fixture.id])).output[0], /Dismiss banner/);
  assert.match((await invoke(root, ["fixture", "list"])).output.join("\n"), /dismiss-banner/);

  const spec = {
    version: 1,
    id: "browse-products",
    title: "Browse products",
    environment: "local",
    steps: [{ intent: "Browse products", expect: ["Products are visible"] }],
  };
  const specFile = path.join(root, "browse-products.yaml");
  await writeFile(specFile, stringifyYaml(spec));
  assert.match((await invoke(root, ["spec", "validate", specFile])).output[0], /browse-products/);
  assert.match((await invoke(root, ["spec", "save", specFile])).output[0], /Saved/);
  assert.match((await invoke(root, ["spec", "validate", spec.id])).output[0], /Valid spec/);
  assert.equal((await invoke(root, ["spec", "delete", spec.id])).exitCode, 0);
  assert.equal((await invoke(root, ["fixture", "delete", fixture.id])).exitCode, 0);

  const environmentsFile = path.join(root, "environments.yaml");
  const environments = await workspace.loadEnvironments();
  await writeFile(environmentsFile, stringifyYaml(environments));
  assert.match((await invoke(root, ["environment", "list"])).output.join("\n"), /local\tweb/);
  assert.match((await invoke(root, ["environment", "show", "desktop"])).output[0], /desktop/);
  assert.match((await invoke(root, ["environment", "validate"])).output[0], /3/);
  assert.match((await invoke(root, ["environment", "validate", environmentsFile])).output[0], /3/);
  assert.match((await invoke(root, ["environment", "save", environmentsFile])).output[0], /Saved 3/);

  const result = passingResult();
  const resultFile = path.join(root, "result.json");
  await writeFile(resultFile, stringifyJson(result));
  assert.match((await invoke(root, ["result", "validate", resultFile])).output[0], /run_20260830_120000/);
  assert.match((await invoke(root, ["result", "save", resultFile])).output[0], /Saved/);
  assert.match((await invoke(root, ["result", "show", result.runId])).output[0], /"classification": "passed"/);
  assert.match((await invoke(root, ["result", "list"])).output.join("\n"), /run_20260830_120000/);
  assert.match((await invoke(root, ["result", "delete", result.runId])).output[0], /Deleted result/);
  assert.match((await invoke(root, ["result", "list"])).output[0], /No entries found/);

  const previousEditor = process.env.EDITOR;
  process.env.EDITOR = "/usr/bin/true";
  try {
    assert.match((await invoke(root, ["edit", "checkout-card"])).output[0], /Saved/);
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
  }
  assert.match(await readFile(workspace.specPath("checkout-card"), "utf8"), /checkout-card/);
});

test("CLI run reports passing and failing classifications", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await invoke(root, ["init"]);
  const variables = { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "password" };
  const passingExecutor = createNativeWebExecutor({
    act: () => ({}),
    observe: () => true,
    screenshot: () => Buffer.from("image"),
  });
  const passed = await invoke(root, ["run", "checkout-card", "--env", "local"], {
    nativeExecutor: passingExecutor,
    variables,
    fetchImpl: async () => ({ status: 200 }),
    onEvent: () => {},
  });
  assert.equal(passed.exitCode, 0);
  assert.match(passed.output.join("\n"), /Saved .qa\/runs/);

  const failingExecutor = createNativeWebExecutor({
    act: () => ({ status: "failed", observation: "Target missing" }),
    observe: () => true,
    screenshot: () => Buffer.from("image"),
  });
  const workspace = new QaWorkspace(root);
  await workspace.saveSpec({
    version: 1,
    id: "failing-journey",
    title: "Failing journey",
    environment: "local",
    steps: [{ intent: "Use the missing control", expect: ["The outcome is visible"] }],
  });
  const failed = await invoke(root, ["run", "failing-journey"], {
    nativeExecutor: failingExecutor,
    variables,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output.join("\n"), /functional_regression/);
});

test("CLI rejects missing values, unknown operations, files, and extra arguments", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await invoke(root, ["init"]);

  const cases = [
    [["init", "--mystery"], "UNKNOWN_OPTION"],
    [["create", "requirement", "--id"], "MISSING_OPTION_VALUE"],
    [["create", "requirement", "--mystery"], "UNKNOWN_OPTION"],
    [["spec"], "UNKNOWN_COMMAND"],
    [["spec", "validate"], "MISSING_ARGUMENT"],
    [["spec", "save"], "MISSING_ARGUMENT"],
    [["spec", "delete"], "MISSING_ARGUMENT"],
    [["fixture"], "UNKNOWN_COMMAND"],
    [["fixture", "validate"], "MISSING_ARGUMENT"],
    [["fixture", "save"], "MISSING_ARGUMENT"],
    [["fixture", "delete"], "MISSING_ARGUMENT"],
    [["environment", "show", "missing"], "UNKNOWN_ENVIRONMENT"],
    [["environment"], "UNKNOWN_COMMAND"],
    [["environment", "save"], "MISSING_ARGUMENT"],
    [["result"], "UNKNOWN_COMMAND"],
    [["result", "validate"], "MISSING_ARGUMENT"],
    [["result", "save"], "MISSING_ARGUMENT"],
    [["result", "delete"], "MISSING_ARGUMENT"],
    [["run"], "MISSING_ARGUMENT"],
    [["run", "checkout-card", "extra"], "UNKNOWN_ARGUMENT"],
    [["run-last", "extra"], "UNKNOWN_ARGUMENT"],
    [["select"], "MISSING_ARGUMENT"],
    [["edit"], "MISSING_ARGUMENT"],
    [["unknown"], "UNKNOWN_COMMAND"],
    [["spec", "save", path.join(root, "missing.yaml")], "NOT_FOUND"],
    [["spec", "save", root], "Unexpected error"],
  ];
  for (const [args, code] of cases) {
    const result = await invoke(root, args);
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.match(result.errors[0], new RegExp(code), args.join(" "));
  }

  const brokenRoot = await mkdtemp(path.join(os.tmpdir(), "auto-qa-cli-broken-fixture-"));
  t.after(() => rm(brokenRoot, { recursive: true, force: true }));
  await invoke(brokenRoot, ["init", "--empty"]);
  await writeFile(path.join(brokenRoot, ".qa/fixtures/login-customer.yaml"), "not: [valid");
  const create = await invoke(brokenRoot, ["create", "an authenticated customer checks out"]);
  assert.equal(create.exitCode, 1);
  assert.match(create.errors[0], /INVALID_YAML/);
});
