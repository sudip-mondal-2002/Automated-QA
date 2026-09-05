import { chromium } from "playwright";
import { createNativeWebExecutor, executeWithReplay } from "../src/index.js";
import { createReplayHarness, percentile } from "../test-support/replay-harness.js";

const harness = await createReplayHarness();
const agentSpec = harness.makeSpec("agent-browser");
await harness.workspace.saveSpec(agentSpec);
const fast = [];
const agent = [];
let agentCalls = 0;
try {
  for (let index = 0; index < 10; index += 1) {
    const result = await executeWithReplay({ workspace: harness.workspace, specId: "fast-browser" });
    if (result.classification !== "passed") throw new Error(result.explanation);
    fast.push(result.execution.attempts.at(-1).durationMs);
  }
  for (let index = 0; index < 10; index += 1) {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const executor = createNativeWebExecutor({
      isAvailable: () => true,
      connect: async (target) => page.goto(target.baseUrl),
      act: async () => { agentCalls += 1; await page.getByRole("button", { name: "Open" }).click(); return { selectedTarget: { summary: "Open", role: "button", name: "Open" } }; },
      observe: async () => ({ status: await page.getByText("Ready", { exact: true }).isVisible() ? "passed" : "failed", observation: "Ready is visible" }),
      screenshot: async () => page.screenshot({ type: "png" }),
      close: async () => { await context.close(); await browser.close(); },
    });
    const result = await executeWithReplay({ workspace: harness.workspace, specId: agentSpec.id, executor });
    if (result.classification !== "passed") throw new Error(result.explanation);
    agent.push(result.execution.attempts.at(-1).durationMs);
  }
  console.log(JSON.stringify({
    runs: 10,
    playwright: { medianMs: percentile(fast, 0.5), p95Ms: percentile(fast, 0.95), agentCalls: 0 },
    agentCompatiblePath: { medianMs: percentile(agent, 0.5), p95Ms: percentile(agent, 0.95), agentCalls },
  }, null, 2));
} finally {
  await harness.close();
}
