import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QaWorkspace } from "../src/index.js";

/**
 * A no-op stand-in for $EDITOR that exits 0 whatever it is handed.
 * `/usr/bin/true` does not exist on Windows, and Node will not spawn a
 * `.cmd` without a shell, so each platform needs its own shape.
 */
export async function noopEditor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-editor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (process.platform === "win32") {
    const file = path.join(directory, "noop.cmd");
    await writeFile(file, "@exit /b 0\r\n");
    return file;
  }
  const file = path.join(directory, "noop.sh");
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  return file;
}

/**
 * Windows refuses symlink creation unless Developer Mode or elevation is on.
 * Tests that need one should skip rather than fail on a policy difference.
 */
export async function canSymlink(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-qa-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  try {
    await symlink(path.join(directory, "target"), path.join(directory, "link"));
    return true;
  } catch {
    return false;
  }
}

/** The installed skill's launcher for this platform. */
export function skillLauncher(installedSkillRoot) {
  return path.join(installedSkillRoot, "scripts", process.platform === "win32" ? "qa-agent.cmd" : "qa-agent");
}

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
