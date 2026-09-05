import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packagedSkill = path.join(repositoryRoot, ".agents", "skills", "autonomous-qa");

function runSkill(launcher, projectRoot, args) {
  return spawnSync(launcher, [...args, "--root", projectRoot], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("installed skill owns setup, native execution, evidence, and UI from an external project", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "auto-qa-skill-package-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "developer demo project");
  const installedSkill = path.join(temporaryRoot, "installed skills", "autonomous-qa");
  await mkdir(projectRoot, { recursive: true });
  await cp(packagedSkill, installedSkill, { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), `${JSON.stringify({
    name: "developer-demo",
    private: true,
    type: "commonjs",
    scripts: { dev: "node server.js" },
  }, null, 2)}\n`);

  const launcher = path.join(installedSkill, "scripts", "qa-agent");
  await chmod(launcher, 0o755);
  const setup = runSkill(launcher, projectRoot, [
    "setup",
    "--type",
    "web",
    "--base-url",
    "http://127.0.0.1:3210",
    "--start-command",
    "npm run dev",
  ]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /QA workspace is ready/);

  const create = runSkill(launcher, projectRoot, [
    "create",
    "a visitor sees the home page",
    "--id",
    "home-page",
    "--env",
    "local",
    "--expect",
    "Home page is visible",
  ]);
  assert.equal(create.status, 0, create.stderr);

  const runtimeSource = await readFile(path.join(installedSkill, "runtime", "qa-agent.mjs"), "utf8");
  assert.doesNotMatch(runtimeSource, /\.\.\/\.\.\/\.\.\/\.\.\/src|\/Users\//);
  const runtime = await import(pathToFileURL(path.join(installedSkill, "runtime", "qa-agent.mjs")));
  const output = [];
  const exitCode = await runtime.runCli(["run-last", "--root", projectRoot], {
    output: (value) => output.push(String(value)),
    error: (value) => output.push(String(value)),
    nativeExecutor: runtime.createNativeWebExecutor({
      act: async () => ({ role: "main", name: "Home" }),
      observe: async () => ({ status: "passed", observation: "Home page is visible" }),
      screenshot: async () => Buffer.from("packaged-screenshot"),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(exitCode, 0, output.join("\n"));
  assert(output.some((line) => line.includes("\tpassed\t")));

  const workspace = new runtime.QaWorkspace(projectRoot);
  const selection = await workspace.readLastTest();
  assert.match(selection.lastRunId, /^run_/);
  const result = await workspace.loadResult(selection.lastRunId);
  assert.equal(result.classification, "passed");
  assert.equal(result.evidence.screenshots.length, 1);

  const application = await runtime.startQaUi({ workspace, port: 0 });
  t.after(() => application.stop());
  const response = await fetch(application.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Intent QA/);

  const projectPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.deepEqual(projectPackage, {
    name: "developer-demo",
    private: true,
    type: "commonjs",
    scripts: { dev: "node server.js" },
  });
});
