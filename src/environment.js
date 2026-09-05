import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { QaError } from "./errors.js";

function assertWebUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new QaError("INVALID_ENVIRONMENT_TARGET", "Resolved web environment URL is invalid", [
      { path: "$.baseUrl", message: "expected an http or https URL" },
    ]);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new QaError("INVALID_ENVIRONMENT_TARGET", "Resolved web environment URL is invalid", [
      { path: "$.baseUrl", message: "only http and https targets are supported" },
    ]);
  }
  return parsed.href;
}

async function reachable(baseUrl, fetchImpl, signal) {
  try {
    const timeout = AbortSignal.timeout(1_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    await fetchImpl(baseUrl, { method: "GET", redirect: "manual", signal: combined });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a shell-spawned application, including anything it started.
 *
 * POSIX: the child is detached into its own process group, so signalling the
 * negative pid reaches the whole tree.
 *
 * Windows has no process groups. `shell: true` means the direct child is
 * `cmd.exe`, and killing it orphans the dev server underneath — which then
 * keeps holding the port. `taskkill /T` walks the tree instead.
 */
export function stopProcessTree(child, { platform = process.platform, spawnSyncImpl } = {}) {
  if (platform !== "win32") {
    process.kill(-child.pid, "SIGTERM");
    return;
  }
  const run = spawnSyncImpl ?? spawnSync;
  const result = run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  // 128 = the process is already gone, which is the outcome we wanted anyway.
  if (result?.error && result.error.code !== "ENOENT") throw result.error;
  if (result?.error || (result?.status !== 0 && result?.status !== 128)) child.kill("SIGTERM");
}

export function spawnApplication(command, repositoryRoot) {
  const child = spawn(command, {
    cwd: repositoryRoot,
    shell: true,
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  child.unref();
  return {
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        stopProcessTree(child);
      } catch (error) {
        // The process finishing before we reached it is success, not failure.
        if (error.code !== "ESRCH") throw error;
      }
    },
  };
}

export async function prepareEnvironment(environment, options = {}) {
  if (environment.type === "desktop") {
    return { target: { ...environment }, startedApplication: null };
  }

  const baseUrl = assertWebUrl(environment.baseUrl);
  const target = { ...environment, baseUrl };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new QaError("ENVIRONMENT_UNREACHABLE", "Web target reachability cannot be checked");
  }
  if (await reachable(baseUrl, fetchImpl, options.signal)) {
    return { target, startedApplication: null };
  }
  if (!environment.startCommand) {
    throw new QaError("ENVIRONMENT_UNREACHABLE", "Web target is not reachable and has no start command", [
      { path: "$.baseUrl", message: "start the application or configure startCommand" },
    ]);
  }

  const startApplication = options.startApplication ?? spawnApplication;
  const startedApplication = await startApplication(environment.startCommand, options.repositoryRoot);
  const timeoutMs = options.startupTimeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) break;
    if (await reachable(baseUrl, fetchImpl, options.signal)) return { target, startedApplication };
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal }).catch(() => {});
  }

  try {
    await startedApplication?.stop?.();
  } catch {}
  throw new QaError("ENVIRONMENT_UNREACHABLE", "Application did not become reachable after startup", [
    { path: "$.baseUrl", message: "verify baseUrl and startCommand" },
  ]);
}
