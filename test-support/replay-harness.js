import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReplayManifest, QaWorkspace, replaySource } from "../src/index.js";

export async function createReplayHarness() {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><button onclick=\"document.querySelector('main').textContent='Ready'\">Open</button><main>Waiting</main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-replay-harness-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workspace = new QaWorkspace(root);
  await workspace.ensureDirectories();
  await workspace.saveEnvironments({ version: 1, environments: { local: { type: "web", baseUrl } } });
  const makeSpec = (id) => ({ version: 1, id, title: id, environment: "local", steps: [{ intent: "Open", expect: ["Ready is visible"] }] });
  const spec = makeSpec("fast-browser");
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
  return {
    workspace,
    baseUrl,
    makeSpec,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
