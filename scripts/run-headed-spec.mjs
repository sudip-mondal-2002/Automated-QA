#!/usr/bin/env node
// Dev/demo-only: run one hand-authored .qa spec through the real skill
// execution engine (executeWithReplay -> executeRun) using a REAL headed
// Chromium browser as the NativeExecutor -- the seat SKILL.md says the host
// agent fills. Mirrors scripts/run-with-playwright.mjs but for a single
// conversational-flow spec instead of the full `orchestrate` pipeline.
//
// Usage: node scripts/run-headed-spec.mjs <workspace-root> <spec-id> [--headless]
import { chromium } from "@playwright/test";
import { QaWorkspace } from "../src/storage.js";
import { executeWithReplay } from "../src/replay.js";
import { createPlaywrightDriver } from "../src/playwright-executor.js";

const [root, specId] = process.argv.slice(2);
const headless = process.argv.includes("--headless");
if (!root || !specId) {
  console.error("Usage: node scripts/run-headed-spec.mjs <workspace-root> <spec-id> [--headless]");
  process.exit(30);
}

const workspace = new QaWorkspace(root);
const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 250 });
try {
  const page = await browser.newPage();
  const executor = createPlaywrightDriver({ page, baseUrl: "http://127.0.0.1:4555" });
  const result = await executeWithReplay({
    workspace,
    specId,
    executor,
    variables: {
      ...process.env,
      QA_CUSTOMER_USERNAME: "demo",
      QA_CUSTOMER_PASSWORD: "demo",
      QA_TEST_CARD: "4242424242424242",
    },
    onEvent: (event) => {
      const subject = event.fixtureId ?? (event.stepIndex ? `step ${event.stepIndex}` : "");
      console.log([event.type, subject, event.status, event.message].filter(Boolean).join(" | "));
    },
  });
  console.log("\n=== RESULT ===");
  console.log(`runId: ${result.runId}`);
  console.log(`classification: ${result.classification}`);
  console.log(`explanation: ${result.explanation}`);
  console.log(`execution.mode: ${result.execution?.mode}`);
  if (result.healing?.length) console.log("healing:", JSON.stringify(result.healing, null, 2));
  process.exitCode = new Set(["passed", "healed"]).has(result.classification) ? 0 : 1;
} finally {
  await browser.close();
}
