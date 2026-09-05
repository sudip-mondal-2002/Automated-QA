import assert from "node:assert/strict";
import test from "node:test";
import { startQaUi } from "../src/ui-server.js";
import { temporaryWorkspace } from "../test-support/helpers.js";

test("the integrated console keeps execution prompt-driven and uses the workspace theme", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const application = await startQaUi({ workspace, port: 0 });
  t.after(() => application.stop());

  const [htmlResponse, scriptResponse, styleResponse] = await Promise.all([
    fetch(application.url),
    fetch(`${application.url}/app.js`),
    fetch(`${application.url}/styles.css`),
  ]);
  const [html, script, styles] = await Promise.all([
    htmlResponse.text(),
    scriptResponse.text(),
    styleResponse.text(),
  ]);

  assert.match(html, /id="demo-console-tab"[^>]*>Console</);
  assert.match(html, /id="demo-console-view" hidden/);
  assert.match(html, /id="demo-url" type="url"/);
  assert.doesNotMatch(html, /id="demo-environment"|<select id="demo-/);
  assert.match(html, /The console reviews planning attempts\. Completed test outcomes live in Workspace\./);
  assert.match(html, /public synthetic demo fixtures, not personal credentials/);
  assert.match(html, /Check Workspace for the latest completed test outcomes/);
  for (const id of [
    "demo-root", "demo-username", "demo-password", "demo-prd", "demo-plan", "demo-out",
    "demo-max-replans", "demo-concurrency", "demo-planning-concurrency", "demo-crawl-concurrency",
    "demo-app-revision", "demo-plan-only", "demo-no-history", "demo-allow-remote", "demo-json",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const flag of [
    "--url", "--username", "--password", "--prompt", "--prd", "--plan", "--plan-only", "--out",
    "--max-replans", "--concurrency", "--planning-concurrency", "--crawl-concurrency", "--no-history",
    "--app-revision", "--allow-remote", "--json", "--root",
  ]) assert.match(html, new RegExp(flag));
  assert.match(html, /id="demo-prompt-preview"/);
  assert.doesNotMatch(html, /id="demo-copy-rerun"|>Copy rerun</);
  assert.match(html, /id="demo-stage-track"/);
  assert.match(html, /id="demo-compare-body"/);
  assert.doesNotMatch(html, /Run Orchestration|External Adapter Command/);

  assert.match(script, /\$autonomous-qa Orchestrate QA for/);
  assert.match(script, /elements\["demo-url"\]\.value\.trim/);
  assert.match(script, /function demoOrchestrationOptions\(\)/);
  assert.match(script, /--allow-remote \(explicit remote authorization\)/);
  assert.match(script, /options\.push\(`--username \$\{username\}`\)/);
  assert.match(script, /options\.push\(`--password \$\{password\}`\)/);
  assert.match(script, /state\.workspace\?\.rerunPrompt/);
  assert.match(script, /renderDemoDashboard/);
  assert.match(script, /renderDemoComparison/);
  assert.doesNotMatch(script, /demo-copy-rerun|Rerun request copied/);
  assert.match(script, /function orchestrationBadge/);
  assert.match(script, /Planning incomplete/);
  assert.match(script, /Execution incomplete/);
  assert.doesNotMatch(script, /function orchestrationStatus/);

  assert.match(styles, /\.product-tab\.active/);
  assert.match(styles, /\.demo-console-grid/);
  assert.match(styles, /\.demo-flag-grid/);
  assert.match(styles, /background: var\(--navy\)/);
  assert.match(styles, /color: var\(--blue\)/);
  assert.doesNotMatch(styles, /color-scheme:\s*dark/);
});
