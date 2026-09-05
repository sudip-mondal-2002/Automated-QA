import { runReplayAttempt } from "../src/index.js";
import { createReplayHarness, percentile } from "../test-support/replay-harness.js";

const harness = await createReplayHarness();
const durations = [];
try {
  for (let index = 0; index < 30; index += 1) {
    const attempt = await runReplayAttempt({ workspace: harness.workspace, specId: "fast-browser" });
    if (attempt.status !== "passed") throw new Error(`soak iteration ${index + 1} failed: ${attempt.reason}`);
    durations.push(attempt.durationMs);
  }
  console.log(JSON.stringify({ runs: durations.length, retries: 0, failures: 0, medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) }, null, 2));
} finally {
  await harness.close();
}
