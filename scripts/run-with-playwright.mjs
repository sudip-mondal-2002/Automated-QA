#!/usr/bin/env node
// Dev/demo-only runner: real-browser orchestration via Playwright.
//
// NOT part of the shipped skill bundle (nothing in src/ or the skill runtime
// imports this file). Requires devDependency `@playwright/test` and a
// downloaded browser (`npx playwright install chromium`). Without them it
// exits 30 with the reason instead of guessing.
//
// Usage:
//   node scripts/run-with-playwright.mjs --url http://127.0.0.1:4555 \
//     --username demo --password demo --prompt "focus on checkout" \
//     --prd docs/prd.md --root /tmp/qa-live [--headed] [--browser chromium]
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

const args = process.argv.slice(2);
const url = option(args, "--url");
const username = option(args, "--username");
const password = option(args, "--password");
const prompt = option(args, "--prompt") ?? "";
const prdPath = option(args, "--prd");
const root = option(args, "--root") ?? process.cwd();
const browserName = option(args, "--browser") ?? "chromium";
const headed = flag(args, "--headed");
const noHistory = flag(args, "--no-history");
const concurrency = Number(option(args, "--concurrency") ?? 3);

if (!url || args.length > 0 || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error("Usage: run-with-playwright.mjs --url <url> [--username <u> --password <p>] [--prompt <text>] [--prd <file>] [--root <dir>] [--headed] [--browser chromium] [--concurrency <n>] [--no-history]");
  process.exit(30);
}

let chromium;
try {
  ({ chromium } = require("@playwright/test"));
} catch {
  console.error("Missing devDependency @playwright/test. Run: npm install --save-dev @playwright/test");
  process.exit(30);
}

const { readFile } = await import("node:fs/promises");
const { orchestrate } = await import("../src/orchestrator.js");
const { createPlaywrightDriver } = await import("../src/playwright-executor.js");

let prdText;
if (prdPath) {
  try {
    prdText = await readFile(prdPath, "utf8");
  } catch {
    console.error(`PRD file is unreadable: ${prdPath}`);
    process.exit(30);
  }
}

const browser = await chromium.launch({ headless: !headed }).catch((error) => {
  console.error(`Could not launch ${browserName}. Run: npx playwright install ${browserName}\n${error.message}`);
  process.exit(30);
});

try {
  const executorFactory = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const executor = createPlaywrightDriver({ page, baseUrl: url });
    executor.driver.close = async () => context.close();
    return executor;
  };
  // QA_TEST_CARD defaults to the demo shop's advertised test card (shown on
  // its checkout page as "saved test card ending in 4242"). Override with a
  // real operator-provided value for any other target. Resolved values are
  // redacted from all output by the runtime.
  const { report, exitCode, error } = await orchestrate({
    url, username, password, prompt, prdText, root, executorFactory, executionConcurrency: concurrency, historyMode: noHistory ? "off" : "lookup",
    variables: { ...process.env, QA_USERNAME: username ?? process.env.QA_USERNAME ?? "demo", QA_PASSWORD: password ?? process.env.QA_PASSWORD ?? "demo", QA_CUSTOMER_USERNAME: username ?? process.env.QA_CUSTOMER_USERNAME ?? "demo", QA_CUSTOMER_PASSWORD: password ?? process.env.QA_PASSWORD ?? process.env.QA_CUSTOMER_PASSWORD ?? "demo", QA_TEST_CARD: process.env.QA_TEST_CARD ?? "4242424242424242" },
  });
  if (error) throw error;
  console.log(`Orchestration ${report.orchestrationId}: ${report.summary.verdict} (exit ${exitCode})`);
  console.log(`Scenarios ${report.summary.scenarios.passed + report.summary.scenarios.healed}/${report.summary.scenarios.total} clean · ${report.summary.scenarios.blocked ?? 0} blocked · ${report.summary.scenarios.failed} failed · coverage ${report.summary.coverage.score}`);
  process.exit(exitCode > 9 ? exitCode : 0);
} finally {
  await browser.close().catch(() => {});
}
