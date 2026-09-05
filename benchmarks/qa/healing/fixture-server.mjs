import { randomBytes } from "node:crypto";
import http from "node:http";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function menuFixture(benchmarkCase, regression) {
  const items = ["Pin Column", "Autosize", "Sort Ascending", "Sort Descending", "Group", "Remove Filter", "Remove Sort", "Hide Column"];
  if (regression) items[benchmarkCase.microfixture.commandIndex - 1] = "Command unavailable";
  return `
    <section aria-label="Grid header menu">
      <h2>Title column</h2>
      <div class="slick-header-menu">
        <p class="menu-label">Commands</p>
        <ul class="slick-menu-command-list" aria-label="Title column commands">
          ${items.map((item) => `<li class="slick-menu-item"><button class="slick-menu-content" type="button">${escapeHtml(item)}</button></li>`).join("")}
        </ul>
      </div>
    </section>`;
}

function toolbarFixture(benchmarkCase, regression) {
  const label = benchmarkCase.microfixture.phase === "before-selection"
    ? "Editor before selection"
    : "Editor after selection removal";
  return `
    <section aria-label="Editor">
      <h2>${escapeHtml(label)}</h2>
      <div class="editor" contenteditable="true">text for selection</div>
      ${regression ? `<div data-kg-floating-toolbar role="toolbar"><button type="button">Bold</button><button type="button">Italic</button></div>` : ""}
    </section>`;
}

function confirmationFixture(benchmarkCase, regression) {
  const clearRecents = benchmarkCase.microfixture.operation === "clear-recents";
  const successScript = clearRecents
    ? `document.querySelectorAll('.c-recentobjects-listitem').forEach((item) => item.remove()); document.querySelector('[aria-label="Clear Recently Viewed"]').disabled = true;`
    : `document.querySelectorAll('[data-related="deleted-folder"]').forEach((item) => item.remove());`;
  return `
    <section aria-label="Recently Viewed">
      <h2>Recently Viewed</h2>
      <button type="button" aria-label="Clear Recently Viewed">Clear Recently Viewed</button>
      <ul>
        <li class="c-recentobjects-listitem" data-related="deleted-folder">Renamed folder</li>
        <li class="c-recentobjects-listitem" data-related="deleted-folder">Clock in renamed folder</li>
        <li class="c-recentobjects-listitem">My Items</li>
      </ul>
      <dialog open aria-label="Confirm operation">
        <p>${clearRecents ? "Clear all recently viewed objects?" : "Delete the renamed folder?"}</p>
        <button type="button" id="confirm-ok">Ok</button>
      </dialog>
      <script>
        document.querySelector('#confirm-ok').addEventListener('click', () => {
          ${regression ? "document.querySelector('dialog').dataset.dismissed = 'true';" : successScript}
        });
      </script>
    </section>`;
}

function treeFixture(regression) {
  return `
    <section aria-label="Test tree">
      <h2>Test tree</h2>
      <div role="tree">
        <div role="treeitem" aria-expanded="false" data-suite="suite">
          <button type="button" class="codicon-chevron-right" aria-label="Expand suite">▶</button>
          <span>suite</span>
          <button type="button" data-annotation-test hidden>annotation test</button>
        </div>
      </div>
      <script>
        document.querySelector('.codicon-chevron-right').addEventListener('click', () => {
          ${regression ? "document.querySelector('[data-suite]').dataset.expandFailed = 'true';" : "document.querySelector('[data-suite]').setAttribute('aria-expanded', 'true'); document.querySelector('[data-annotation-test]').hidden = false;"}
        });
      </script>
    </section>`;
}

function tagFixture(regression) {
  return `
    <section aria-label="Test filters">
      <h2>Native tags</h2>
      <label>Filter <input placeholder="Filter" value=""></label>
      <div class="ui-mode-tree-item-title"><button type="button" data-smoke-tag>smoke</button></div>
      <ul data-test-tree>
        <li data-test-name="p">p</li>
        <li data-test-name="pwt" data-tag="@smoke">pwt</li>
      </ul>
      <script>
        document.querySelector('[data-smoke-tag]').addEventListener('click', () => {
          ${regression ? "document.querySelector('[data-test-tree]').dataset.filterFailed = 'true';" : "document.querySelector('[placeholder=Filter]').value = '@smoke'; document.querySelector('[data-test-name=p]').hidden = true;"}
        });
      </script>
    </section>`;
}

function fixtureBody(benchmarkCase, regression) {
  switch (benchmarkCase.microfixture.kind) {
    case "nested-menu-command": return menuFixture(benchmarkCase, regression);
    case "toolbar-absence": return toolbarFixture(benchmarkCase, regression);
    case "exact-name-confirmation": return confirmationFixture(benchmarkCase, regression);
    case "aria-treeitem": return treeFixture(regression);
    case "renamed-tree-title-class": return tagFixture(regression);
    default: throw new Error(`Unsupported microfixture kind: ${benchmarkCase.microfixture.kind}`);
  }
}

export function renderFixture(benchmarkCase, variant) {
  const regression = variant === "regression";
  if (!new Set(["drift", "regression"]).has(variant)) throw new Error(`Unsupported fixture variant: ${variant}`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Interaction workspace</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f5f7fb; color: #172033; }
      body { margin: 0; padding: 28px; }
      main { max-width: 820px; margin: auto; background: white; border: 1px solid #dbe2ef; border-radius: 16px; box-shadow: 0 12px 32px #1f33521a; padding: 28px; }
      h1 { margin-top: 0; font-size: 22px; } h2 { font-size: 18px; }
      section { padding-top: 4px; }
      button, input { font: inherit; padding: 8px 12px; margin: 4px; } li { margin: 5px 0; }
      .slick-header-menu { padding: 10px; border: 1px solid #aebbd0; border-radius: 8px; }
      .slick-menu-command-list { list-style: none; padding: 0; } .slick-menu-content { min-width: 180px; text-align: left; }
      .editor { min-height: 70px; padding: 12px; border: 1px solid #aebbd0; border-radius: 8px; }
      [data-kg-floating-toolbar] { margin-top: 8px; padding: 6px; background: #172033; color: white; border-radius: 8px; }
      output { display: block; margin-top: 18px; padding: 12px; border-radius: 8px; background: #eef2f8; font-weight: 700; }
      output[data-status="passed"] { background: #e8f6ef; color: #17603d; }
      output[data-status="failed"] { background: #ffe9e7; color: #9c2d24; }
    </style>
  </head>
  <body>
    <main>
      <h1>QA scenario ${escapeHtml(benchmarkCase.id)}</h1>
      <p><strong>Intent:</strong> ${escapeHtml(benchmarkCase.semanticIntent)}</p>
      <p><strong>Expectation:</strong> ${escapeHtml(benchmarkCase.expectation)}</p>
      ${fixtureBody(benchmarkCase, regression)}
      <output id="qa-outcome" data-status="pending">Ready for interaction</output>
    </main>
  </body>
</html>`;
}

export async function startFixtureServer(cases) {
  const scenarios = new Map();
  const tokens = new Map();
  for (const benchmarkCase of cases) {
    for (const variant of ["drift", "regression"]) {
      const key = `${benchmarkCase.id}:${variant}`;
      let token;
      do token = randomBytes(16).toString("hex");
      while (scenarios.has(token));
      scenarios.set(token, { benchmarkCase, variant });
      tokens.set(key, token);
    }
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("reprobreak-healing-core-v1 ready");
      return;
    }
    const match = url.pathname.match(/^\/scenario\/([a-f0-9]{32})$/);
    const scenario = match ? scenarios.get(match[1]) : undefined;
    if (!scenario) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(renderFixture(scenario.benchmarkCase, scenario.variant));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    urlFor(caseId, variant) {
      const token = tokens.get(`${caseId}:${variant}`);
      if (!token) throw new Error(`Unknown fixture scenario: ${caseId}`);
      return `http://127.0.0.1:${address.port}/scenario/${token}`;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
