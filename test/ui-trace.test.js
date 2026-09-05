import assert from "node:assert/strict";
import test from "node:test";
import { orchestrate } from "../src/orchestrator.js";
import { startQaUi } from "../src/ui-server.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { temporaryWorkspace } from "../test-support/helpers.js";
import { createDemoApplication } from "../demo-app/server.js";

test("UI serves orchestration trace with since filtering", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication();
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  const { report, artifacts } = await orchestrate({
    url: baseUrl,
    root: workspace.repositoryRoot,
    maxPages: 3,
    maxDepth: 1,
    executor: demoNativeExecutor(),
    variables: { QA_CUSTOMER_USERNAME: "u", QA_CUSTOMER_PASSWORD: "p" },
  });
  const orchId = report.orchestrationId;
  const app = await startQaUi({ workspace, port: 0 });
  t.after(() => app.stop());
  const all = await (await fetch(`${app.url}/api/orchestrations/${orchId}/trace`)).json();
  assert.ok(all.events.length > 0);
  const firstSeq = all.events[0].seq;
  const filtered = await (await fetch(`${app.url}/api/orchestrations/${orchId}/trace?since=${firstSeq}`)).json();
  assert.ok(filtered.events.every((e) => e.seq > firstSeq));
  const missing = await (await fetch(`${app.url}/api/orchestrations/nope/trace`)).json();
  assert.deepEqual(missing.events, []);
  void artifacts;
});
