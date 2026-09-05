import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createQaUiServer,
  executeRun,
  QaWorkspace,
} from "../../src/index.js";
import {
  createDemoApplication,
  resetDemoState,
} from "../../demo-app/server.js";
import { demoNativeExecutor } from "../../test-support/demo-native-executor.js";

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "auto-qa-video-"));
const workspace = new QaWorkspace(workspaceRoot);
await workspace.init();

const demo = createDemoApplication();
const demoUrl = await demo.start(4312);
const environments = await workspace.loadEnvironments();
environments.environments.local = { type: "web", baseUrl: demoUrl };
await workspace.saveEnvironments(environments);

const designSpec = await workspace.loadSpec("checkout-design");
designSpec.design.reference = `${demoUrl}/reference/approved-confirmation`;
await workspace.saveSpec(designSpec);

const runs = [
  { scenario: "pass", specId: "checkout-card", runId: "run_20260901_090001_pass", at: "2026-09-01T09:00:01.000Z" },
  { scenario: "drift", specId: "checkout-card", runId: "run_20260901_090002_healed", at: "2026-09-01T09:00:02.000Z" },
  { scenario: "functional", specId: "checkout-card", runId: "run_20260901_090003_functional", at: "2026-09-01T09:00:03.000Z" },
  { scenario: "design", specId: "checkout-design", runId: "run_20260901_090004_design", at: "2026-09-01T09:00:04.000Z" },
];

for (const run of runs) {
  resetDemoState(demo.state, run.scenario);
  await executeRun({
    workspace,
    specId: run.specId,
    runId: run.runId,
    executor: demoNativeExecutor(),
    variables: {
      QA_CUSTOMER_USERNAME: "demo-customer",
      QA_CUSTOMER_PASSWORD: "demo-password",
    },
    clock: () => new Date(run.at),
  });
}
resetDemoState(demo.state, "pass");

const ui = createQaUiServer({ workspace });
const uiUrl = await ui.start({ port: 4190 });
console.log(JSON.stringify({ ready: true, repositoryRoot, workspaceRoot, demoUrl, uiUrl, runs }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await ui.stop();
  await demo.stop();
  await rm(workspaceRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}

await new Promise(() => {});
