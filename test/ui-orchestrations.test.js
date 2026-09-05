import assert from "node:assert/strict";
import test from "node:test";
import { orchestrate } from "../src/orchestrator.js";
import { startQaUi } from "../src/ui-server.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { temporaryWorkspace } from "../test-support/helpers.js";
import { createDemoApplication } from "../demo-app/server.js";

async function orchestrated(t, options = {}) {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication();
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  const { report } = await orchestrate({
    url: baseUrl,
    root: workspace.repositoryRoot,
    maxPages: 3,
    maxDepth: 1,
    executor: demoNativeExecutor(),
    variables: { QA_CUSTOMER_USERNAME: "u", QA_CUSTOMER_PASSWORD: "p" },
    ...options,
  });
  const app = await startQaUi({ workspace, port: 0 });
  t.after(() => app.stop());
  return { app, report, workspace };
}

const json = async (url) => (await fetch(url)).json();

test("the UI lists orchestrations newest first with their verdict", async (t) => {
  const { app, report } = await orchestrated(t);
  const { orchestrations } = await json(`${app.url}/api/orchestrations`);
  assert.equal(orchestrations.length, 1);
  const [entry] = orchestrations;
  assert.equal(entry.orchestrationId, report.orchestrationId);
  assert.equal(entry.verdict, report.summary.verdict);
  assert.equal(entry.score, report.summary.coverage.score);
  assert.equal(entry.planner, "deterministic");
  assert.ok(entry.target);
});

test("an orchestration exposes the whole decision record, not just the trace", async (t) => {
  const { app, report } = await orchestrated(t, {
    prompt: "focus on checkout",
    prdText: "REQ-1 Checkout\nA customer can complete a purchase.\n\nREQ-2 Promos\nA promo code reduces the total.\n",
  });
  const detail = await json(`${app.url}/api/orchestrations/${report.orchestrationId}`);

  // Everything the timeline view needs, in one request.
  assert.equal(detail.orchestrationId, report.orchestrationId);
  assert.equal(detail.checklist.length, 12, "every gate rule is reported, including the ones that passed");
  assert.ok(detail.flows.length > 0);
  assert.ok(detail.flows[0].id && detail.flows[0].category);
  assert.equal(typeof detail.flows[0].steps, "number");
  assert.equal(detail.planSource.planner, "deterministic");
  assert.ok(Array.isArray(detail.openQuestions));
  assert.ok(Array.isArray(detail.untestedRisks));

  // The checklist keeps its severities so the view can show what actually
  // blocked the run versus what was only reported.
  assert.ok(detail.checklist.every((entry) => ["blocking", "advisory"].includes(entry.severity)));
});

test("a gate gap carries either a hint or a suggested flow, so a rejection is always actionable", async (t) => {
  const { app, report } = await orchestrated(t, { prompt: "focus on checkout" });
  const detail = await json(`${app.url}/api/orchestrations/${report.orchestrationId}`);
  for (const gap of detail.gaps) {
    assert.ok(gap.hint || gap.suggestion, `gap ${gap.id} (${gap.ruleId}) explains nothing`);
  }
});

test("an unknown orchestration is a 404, not an empty shell", async (t) => {
  const { app } = await orchestrated(t);
  const response = await fetch(`${app.url}/api/orchestrations/orch_does_not_exist`);
  assert.equal(response.status, 404);
  // The trace route stays lenient: it is polled while a run is still writing.
  const trace = await json(`${app.url}/api/orchestrations/orch_does_not_exist/trace`);
  assert.deepEqual(trace.events, []);
});
