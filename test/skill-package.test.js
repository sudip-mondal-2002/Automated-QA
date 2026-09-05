import assert from "node:assert/strict";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { skillLauncher } from "../test-support/helpers.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packagedSkill = path.join(repositoryRoot, ".agents", "skills", "autonomous-qa");

async function hasChrome() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`]
      : ["/usr/bin/google-chrome"];
  for (const candidate of candidates) {
    try { await access(candidate); return true; } catch {}
  }
  return false;
}

function runSkill(launcher, projectRoot, args) {
  const full = [...args, "--root", projectRoot];
  if (process.platform !== "win32") {
    return spawnSync(launcher, full, { cwd: projectRoot, encoding: "utf8" });
  }
  // Node refuses to spawn a .cmd without a shell (CVE-2024-27980), and with a
  // shell it quotes nothing — so build the command line ourselves. The skill is
  // deliberately installed under a path containing a space.
  const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  return spawnSync([launcher, ...full].map(quote).join(" "), {
    cwd: projectRoot,
    encoding: "utf8",
    shell: true,
  });
}

test("installed skill owns setup, native execution, evidence, and UI from an external project", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "auto-qa-skill-package-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "developer demo project");
  const installedSkill = path.join(temporaryRoot, "installed skills", "autonomous-qa");
  await mkdir(projectRoot, { recursive: true });
  await cp(packagedSkill, installedSkill, { recursive: true });
  await assert.rejects(access(path.join(installedSkill, "runtime", "node_modules")), { code: "ENOENT" });
  await access(path.join(installedSkill, "runtime", "playwright-core", "package.json"));
  await access(path.join(installedSkill, "runtime", "playwright-core", "browsers.json"));
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

  if (await hasChrome()) {
    const target = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<button onclick=\"document.querySelector('main').textContent='Home page'\">Open</button><main>Waiting</main>");
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => target.close(resolve)));
    const baseUrl = `http://127.0.0.1:${target.address().port}`;
    await workspace.saveEnvironments({ version: 1, environments: { local: { type: "web", baseUrl } } });
    const script = `export default async function replay({ page, expect, checkpoint, target, baseURL }) {
  await page.goto(baseURL);
  await (await target([{ strategy: "role", value: ["button", { name: "Open" }] }])).click();
  await checkpoint(1, 0, async () => { await expect(page.getByText("Home page", { exact: true })).toBeVisible(); });
}\n`;
    const source = await runtime.replaySource(workspace, "home-page", "local");
    const manifest = runtime.createReplayManifest({ specId: "home-page", environment: "local", sourceHash: source.sourceHash, script, coverage: { deterministic: 1, total: 1, complete: true }, state: "trusted" });
    manifest.validation = { required: 3, passed: 3 };
    await workspace.saveReplayArtifacts("home-page", script, manifest);
    const fastOutput = [];
    const fastExit = await runtime.runCli(["run-last", "--root", projectRoot], { output: (value) => fastOutput.push(String(value)), error: (value) => fastOutput.push(String(value)) });
    assert.equal(fastExit, 0, fastOutput.join("\n"));
    const fastSelection = await workspace.readLastTest();
    const fastResult = await workspace.loadResult(fastSelection.lastRunId);
    assert.equal(fastResult.execution.mode, "playwright");
    assert.equal(fastResult.execution.agentCalls, 0);
    assert.deepEqual(fastResult.evidence.screenshots, []);
  }

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
