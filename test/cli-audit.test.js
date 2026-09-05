import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { executeRun } from "../src/execution.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { temporaryWorkspace } from "../test-support/helpers.js";
import { createDemoApplication } from "../demo-app/server.js";

function capture() {
  const output = [];
  const errors = [];
  return { output, errors, io: { output: (v) => output.push(String(v)), error: (v) => errors.push(String(v)) } };
}

test("qa-agent audit passes a clean native run and fails a tampered one", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const demo = createDemoApplication();
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  const environments = await workspace.loadEnvironments();
  environments.environments.local = { type: "web", baseUrl };
  await workspace.saveEnvironments(environments);

  const result = await executeRun({
    workspace,
    specId: "checkout-card",
    environmentId: "local",
    executor: demoNativeExecutor(),
    variables: { QA_CUSTOMER_USERNAME: "u", QA_CUSTOMER_PASSWORD: "p" },
  });

  const ok = capture();
  assert.equal(await runCli(["audit", result.runId, "--root", workspace.repositoryRoot], ok.io), 0);
  assert.ok(ok.output.some((line) => line.startsWith("PASS")));
  assert.ok(ok.output.some((line) => line.includes("Governance audit passed")));

  const missing = capture();
  assert.equal(await runCli(["audit", "--root", workspace.repositoryRoot], missing.io), 1);
  assert.match(missing.errors.join("\n"), /audit requires a run ID/);

  const extra = capture();
  assert.equal(await runCli(["audit", result.runId, "bogus", "--root", workspace.repositoryRoot], extra.io), 1);
});

test("qa-agent create honors explicit channels and rejects bad ones", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const chat = capture();
  assert.equal(await runCli(["create", "chat with support about refunds", "--id", "chat-refund", "--channel", "chat", "--root", workspace.repositoryRoot], chat.io), 0);
  assert.equal((await workspace.loadSpec("chat-refund")).steps[0].channel, "chat");

  const bad = capture();
  assert.equal(await runCli(["create", "do a thing", "--id", "bad-chan", "--channel", "sms", "--root", workspace.repositoryRoot], bad.io), 1);
  assert.match(bad.errors.join("\n"), /Channel must be one of/);
});
