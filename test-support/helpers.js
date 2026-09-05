import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QaWorkspace } from "../src/index.js";

export async function temporaryWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-qa-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new QaWorkspace(root);
  await workspace.init();
  return { root, workspace };
}

export function passingResult(overrides = {}) {
  return {
    version: 1,
    runId: "run_20260830_120000",
    specId: "checkout-card",
    environment: "local",
    classification: "passed",
    startedAt: "2026-08-30T12:00:00.000Z",
    completedAt: "2026-08-30T12:00:03.000Z",
    steps: [],
    ...overrides,
  };
}
