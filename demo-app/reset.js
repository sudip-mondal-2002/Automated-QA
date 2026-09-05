#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEMO_SCENARIOS } from "./server.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export async function resetRunningDemo({
  scenario,
  baseUrl = "http://127.0.0.1:3000",
  fetchImpl = fetch,
} = {}) {
  if (!Object.hasOwn(DEMO_SCENARIOS, scenario)) {
    throw new TypeError(`Scenario must be one of: ${Object.keys(DEMO_SCENARIOS).join(", ")}`);
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError("Demo reset URL must use HTTP on localhost");
  }
  const response = await fetchImpl(new URL("/__demo/reset", url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ scenario }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Demo reset failed with HTTP ${response.status}`);
  return { ...result, url: new URL("/", url).href };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");
  const baseUrl = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
  if (urlIndex >= 0) args.splice(urlIndex, 2);
  if (args.length !== 1) {
    console.error(`Usage: npm run demo:reset -- <${Object.keys(DEMO_SCENARIOS).join("|")}> [--url http://127.0.0.1:3000]`);
    process.exitCode = 1;
  } else {
    try {
      const reset = await resetRunningDemo({ scenario: args[0], baseUrl });
      console.log(`Demo reset to ${reset.scenario} (${reset.variant}) at ${reset.url}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
