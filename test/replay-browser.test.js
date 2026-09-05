import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReplayManifest, executeWithReplay, QaWorkspace, replaySource } from "../src/index.js";

async function browserInstalled() {
  const paths = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : process.platform === "win32"
      ? [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`]
      : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge"];
  for (const candidate of paths) {
    try { await access(candidate); return true; } catch {}
  }
  return false;
}

test("the bundled Playwright path executes a real browser script with no agent", { skip: !(await browserInstalled()) }, async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><button onclick=\"document.querySelector('main').textContent='Ready'\">Open</button><main>Waiting</main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-real-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workspace = new QaWorkspace(root);
  await workspace.ensureDirectories();
  await workspace.saveEnvironments({ version: 1, environments: { local: { type: "web", baseUrl } } });
  const spec = { version: 1, id: "real-browser", title: "Real browser", environment: "local", steps: [{ intent: "Open", expect: ["Ready is visible"] }] };
  await workspace.saveSpec(spec);
  const script = `export default async function replay({ page, expect, checkpoint, target, baseURL }) {
  await page.goto(baseURL);
  await (await target([{ strategy: "role", value: ["button", { name: "Open" }] }])).click();
  await checkpoint(1, 0, async () => { await expect(page.getByText("Ready", { exact: true })).toBeVisible(); });
}
`;
  const source = await replaySource(workspace, spec.id, spec.environment);
  const manifest = createReplayManifest({ specId: spec.id, environment: spec.environment, sourceHash: source.sourceHash, script, coverage: { deterministic: 1, total: 1, complete: true }, state: "trusted" });
  manifest.validation = { required: 3, passed: 3 };
  await workspace.saveReplayArtifacts(spec.id, script, manifest);
  const result = await executeWithReplay({ workspace, specId: spec.id });
  assert.equal(result.classification, "passed");
  assert.equal(result.execution.mode, "playwright");
  assert.equal(result.execution.agentCalls, 0);
  assert.match(result.execution.attempts[0].browserChannel, /^(chrome|msedge)$/);
});
