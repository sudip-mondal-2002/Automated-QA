import { spawn } from "node:child_process";
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
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) {
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
