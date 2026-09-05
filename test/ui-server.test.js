import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createQaUiServer,
  QaError,
  startQaUi,
  stringifyYaml,
} from "../src/index.js";
import { passingResult, temporaryWorkspace } from "../test-support/helpers.js";

async function runningUi(t, options = {}) {
  const temporary = await temporaryWorkspace(t);
  const application = createQaUiServer({ workspace: temporary.workspace, ...options });
  const url = await application.start({ port: 0 });
  t.after(() => application.stop());
  return { ...temporary, application, url };
}

async function json(response) {
  const value = await response.json();
  return { response, value };
}

test("localhost UI serves its shell, workspace summary, run detail, and declared screenshots", async (t) => {
  const { application, url, workspace } = await runningUi(t);
  for (const [fileName, contents] of [
    ["step.png", Buffer.from("png evidence")],
    ["healing.webp", Buffer.from("webp evidence")],
    ["design.jpg", Buffer.from("jpeg evidence")],
  ]) {
    await workspace.saveScreenshot("run_20260830_160000", fileName, contents);
  }
  await workspace.saveResult(passingResult({
    runId: "run_20260830_160000",
    startedAt: "2026-08-30T16:00:00.000Z",
    completedAt: "2026-08-30T16:00:03.000Z",
    explanation: "Checkout completed with visible confirmation.",
    evidence: { screenshots: ["screenshots/step.png", "screenshots/healing.webp", "screenshots/design.jpg"] },
  }));
  await workspace.saveResult(passingResult({
    runId: "run_20260830_155900",
    specId: "checkout-saved-card",
    startedAt: "2026-08-30T15:59:00.000Z",
    completedAt: "2026-08-30T15:59:03.000Z",
  }));

  const health = await json(await fetch(`${url}/api/health`));
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.value, { status: "ready" });

  for (const [pathname, contentType, content] of [
    ["/", "text/html", /Intent QA/],
    ["/app.js", "text/javascript", /refreshWorkspace/],
    ["/styles.css", "text/css", /\[hidden\] \{ display: none !important; \}/],
  ]) {
    const response = await fetch(`${url}${pathname}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), new RegExp(contentType));
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await response.text(), content);
  }

  const summary = await json(await fetch(`${url}/api/workspace`));
  assert.equal(summary.value.tests.length, 3);
  assert.equal(summary.value.fixtures.length, 2);
  assert.equal(summary.value.environments.length, 3);
  assert.match(summary.value.rerunPrompt, /^\$autonomous-qa Rerun/);
  assert.equal(summary.value.tests.find((entry) => entry.id === "checkout-card").lastStatus, "passed");
  assert.equal(summary.value.tests.find((entry) => entry.id === "checkout-design").lastStatus, "not_run");
  assert.match(summary.value.tests[0].runPrompt, /^\$autonomous-qa Run /);
  assert.equal(summary.value.recentRuns[0].explanation, "Checkout completed with visible confirmation.");
  assert.equal(summary.value.recentRuns[1].explanation, "No explanation was recorded.");
  assert.equal(summary.value.recentRuns[1].screenshotCount, 0);

  const detail = await json(await fetch(`${url}/api/runs/run_20260830_160000`));
  assert.equal(detail.value.result.runId, "run_20260830_160000");
  for (const [fileName, contentType] of [
    ["step.png", "image/png"],
    ["healing.webp", "image/webp"],
    ["design.jpg", "image/jpeg"],
  ]) {
    const screenshot = await fetch(`${url}/api/runs/run_20260830_160000/screenshots/${fileName}`);
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get("content-type"), contentType);
    assert((await screenshot.arrayBuffer()).byteLength > 0);
  }
  const undeclared = await json(await fetch(`${url}/api/runs/run_20260830_160000/screenshots/missing.png`));
  assert.equal(undeclared.response.status, 404);
  assert.equal(undeclared.value.error.code, "NOT_FOUND");

  await application.stop();
  await application.stop();
});

test("localhost UI validates and atomically edits spec and fixture YAML", async (t) => {
  const { url, workspace } = await runningUi(t);
  const specResponse = await json(await fetch(`${url}/api/documents/specs/checkout-card`));
  assert.equal(specResponse.value.kind, "spec");
  assert.match(specResponse.value.yaml, /Customer completes checkout/);
  const fixtureResponse = await json(await fetch(`${url}/api/documents/fixtures/login-customer`));
  assert.equal(fixtureResponse.value.kind, "fixture");

  for (const [collection, id, yaml] of [
    ["specs", "checkout-card", specResponse.value.yaml],
    ["fixtures", "login-customer", fixtureResponse.value.yaml],
  ]) {
    const validated = await json(await fetch(`${url}/api/documents/${collection}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, yaml }),
    }));
    assert.equal(validated.response.status, 200);
    assert.equal(validated.value.document.id, id);
  }

  const updatedYaml = specResponse.value.yaml.replace(
    "title: Customer completes checkout",
    "title: Customer completes checkout visibly",
  );
  const saved = await json(await fetch(`${url}/api/documents/specs/checkout-card`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yaml: updatedYaml }),
  }));
  assert.equal(saved.value.saved, true);
  assert.equal(saved.value.document.title, "Customer completes checkout visibly");
  assert.equal((await workspace.loadSpec("checkout-card")).title, "Customer completes checkout visibly");

  const invalidCases = [
    ["/api/documents/specs/validate", "POST", "not json", 422, "INVALID_REQUEST_JSON"],
    ["/api/documents/specs/validate", "POST", "[]", 422, "INVALID_REQUEST_JSON"],
    ["/api/documents/specs/validate", "POST", JSON.stringify({ yaml: "not: [yaml" }), 422, "INVALID_YAML"],
    ["/api/documents/specs/validate", "POST", JSON.stringify({ id: "another-id", yaml: updatedYaml }), 409, "ID_MISMATCH"],
    ["/api/documents/specs/checkout-card", "PUT", JSON.stringify({ yaml: updatedYaml.replace("id: checkout-card", "id: another-id") }), 409, "ID_MISMATCH"],
    ["/api/documents/unknown/validate", "POST", JSON.stringify({ yaml: updatedYaml }), 422, "UNKNOWN_DOCUMENT_KIND"],
    ["/api/documents/specs/checkout-card", "DELETE", undefined, 405, "METHOD_NOT_ALLOWED"],
    ["/api/runs/run_20260830_160000", "POST", undefined, 405, "METHOD_NOT_ALLOWED"],
  ];
  for (const [pathname, method, body, status, code] of invalidCases) {
    const failure = await json(await fetch(`${url}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body,
    }));
    assert.equal(failure.response.status, status, pathname);
    assert.equal(failure.value.error.code, code, pathname);
  }

  const tooLarge = await json(await fetch(`${url}/api/documents/specs/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yaml: "x".repeat(1_000_001) }),
  }));
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.value.error.code, "REQUEST_TOO_LARGE");

  const missing = await json(await fetch(`${url}/api/documents/specs/missing-spec`));
  assert.equal(missing.response.status, 404);
  const unknownRoute = await json(await fetch(`${url}/api/not-here`));
  assert.equal(unknownRoute.response.status, 404);
  const malformedRoute = await json(await fetch(`${url}/api/%E0%A4%A`));
  assert.equal(malformedRoute.response.status, 422);
  assert.equal(malformedRoute.value.error.code, "INVALID_ROUTE");
});

test("localhost UI deletes exactly one selected run and safely repairs its pointer", async (t) => {
  const { url, workspace } = await runningUi(t);
  await workspace.saveResult(passingResult({
    runId: "run_20260830_170000",
    startedAt: "2026-08-30T17:00:00.000Z",
    completedAt: "2026-08-30T17:00:03.000Z",
  }));
  await workspace.saveResult(passingResult({
    runId: "run_20260830_170001",
    startedAt: "2026-08-30T17:00:04.000Z",
    completedAt: "2026-08-30T17:00:07.000Z",
  }));

  const deleted = await json(await fetch(`${url}/api/runs/run_20260830_170001`, { method: "DELETE" }));
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.value, { deleted: true, runId: "run_20260830_170001" });
  assert.equal((await workspace.readLastTest()).lastRunId, "run_20260830_170000");
  assert.equal((await workspace.loadResult("run_20260830_170000")).runId, "run_20260830_170000");
  const gone = await json(await fetch(`${url}/api/runs/run_20260830_170001`));
  assert.equal(gone.response.status, 404);
});

test("UI startup remains loopback-only and reports unexpected asset failures without leaking details", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const [host, port, code] of [
    ["0.0.0.0", 0, "INVALID_UI_HOST"],
    ["127.0.0.1", -1, "INVALID_UI_PORT"],
    ["127.0.0.1", 65_536, "INVALID_UI_PORT"],
    ["127.0.0.1", 4.2, "INVALID_UI_PORT"],
  ]) {
    const application = createQaUiServer({ workspace });
    await assert.rejects(
      () => application.start({ host, port }),
      (error) => error instanceof QaError && error.code === code,
    );
  }

  await unlink(workspace.lastTestPath);
  const emptySelection = createQaUiServer({ workspace });
  const emptyUrl = await emptySelection.start({ port: 0 });
  t.after(() => emptySelection.stop());
  const summary = await json(await fetch(`${emptyUrl}/api/workspace`));
  assert.equal(summary.value.selected, null);
  await writeFile(workspace.lastTestPath, "not json");
  const corruptSelection = await json(await fetch(`${emptyUrl}/api/workspace`));
  assert.equal(corruptSelection.response.status, 422);
  assert.equal(corruptSelection.value.error.code, "INVALID_JSON");

  const missingAssets = await mkdtemp(path.join(os.tmpdir(), "auto-qa-ui-assets-"));
  t.after(() => rm(missingAssets, { recursive: true, force: true }));
  const broken = createQaUiServer({ workspace, assetsDirectory: missingAssets });
  const brokenUrl = await broken.start({ port: 0 });
  t.after(() => broken.stop());
  const failure = await json(await fetch(`${brokenUrl}/`));
  assert.equal(failure.response.status, 500);
  assert.deepEqual(failure.value.error, {
    code: "UNEXPECTED_ERROR",
    message: "The QA UI could not complete the request",
    issues: [],
  });

  const wrapper = await startQaUi({ workspace, port: 0 });
  assert.match(wrapper.url, /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await fetch(`${wrapper.url}/api/health`)).status, 200);
  await wrapper.stop();
});
