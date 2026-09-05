# Live demo runbook

This is the exact judge-facing path. It shows installation and developer experience first, then proves the correctness boundaries with the same semantic test.

Target length: **five minutes**. Keep the demo application, QA workspace, and Codex task visible in separate tabs. Do not use `artifacts/demo-video/recording-server.mjs` during the live demo; that helper exists only to produce deterministic media assets.

## Preflight

Run these checks before the session, then leave the repository clean:

```bash
npm install
npm run qa-agent -- init
npm run qa-agent -- validate
npm run test:coverage
```

Open two terminals:

```bash
# Terminal 1 — deterministic application under test
npm run demo

# Terminal 2 — file-backed QA workspace
npm run ui
```

Open these pages:

- Application: `http://127.0.0.1:3000`
- QA workspace: `http://127.0.0.1:4173`

Set the demo-only fixture variables in the Codex environment. Do not type them while recording or while screenshots are being captured:

```bash
export QA_CUSTOMER_USERNAME=demo-customer
export QA_CUSTOMER_PASSWORD=demo-password
```

## Five-minute sequence

### 0:00–0:20 — State the promise

Say:

> UI tests usually fail for the wrong reason: a selector changed. This project stores intent and observable outcomes instead. It can recover a harmless interaction change, but it will not rewrite an assertion or normalize a real product or design bug.

Show the QA workspace overview. Point out that tests, fixtures, recent runs, and evidence are one file-backed workspace—not a separate SaaS dashboard.

### 0:20–0:55 — Show installation and validation

Run:

```bash
npm install
npm run qa-agent -- init
npm run qa-agent -- validate
npm run qa-agent -- spec list
```

Say:

> Installation is ordinary npm. Init is idempotent, so it creates missing QA files without overwriting edits. Validate applies JSON Schema plus cross-file checks before a browser is opened.

### 0:55–1:25 — Create and inspect a semantic test

Run:

```bash
npm run qa-agent -- create \
  "a logged-in customer completes checkout" \
  --id live-checkout \
  --env local \
  --fixture-before login-customer \
  --expect "Order confirmation is visible"
```

Select `live-checkout` in the workspace UI and show its YAML. Do not spend time editing prose. Point out the intent, expectation, environment, and fixture—and the absence of CSS selectors, XPath, coordinates, or fixed waits.

Say:

> This YAML is the source of truth. The UI and CLI use the same validator and atomic save path, so there is no browser-only copy of the test.

Delete `live-checkout` after the demo if it is not needed:

```bash
npm run qa-agent -- select checkout-card --env local
npm run qa-agent -- spec delete live-checkout
```

### 1:25–2:10 — Run the stable checkout

Reset the target:

```bash
npm run demo:reset -- pass
```

In Codex, submit this exact request:

```text
Use $autonomous-qa to run checkout-card --env local. Drive the live app with the native Browser and save the result and screenshots.
```

Show the Browser performing login, cart, checkout, and confirmation. Then switch to the QA workspace; its polling should reveal the completed run automatically. Select it and point out:

- every original expectation passed;
- the selected accessible targets are recorded;
- fixture and step screenshots are attached;
- the result is `passed`.

### 2:10–2:55 — Prove conservative healing

Change the application, not the test:

```bash
npm run demo:reset -- drift
```

In Codex:

```text
Use $autonomous-qa to run checkout-card --env local again. Keep every expectation unchanged.
```

Open the cart and show that “Proceed to checkout” moved into “Checkout options” and became “Continue to payment.” In the result, show the failed original target, the explicitly equivalent replacement, the single retry, before/after evidence, and the unchanged checkout-form expectation.

Say:

> The interaction changed, not the requirement. Healing is allowed once because the replacement is explicitly equivalent and the original expectation passes unchanged.

### 2:55–3:30 — Prove that a real bug stays failed

Run:

```bash
npm run demo:reset -- functional
```

Rerun the same `checkout-card` spec. Show “Order could not be completed,” then open the new result.

Say:

> The click succeeded, but the required outcome failed. That is not interaction drift, so the agent refuses to heal it and records `functional_regression`. The assertion still says “Order confirmation is visible.”

### 3:30–4:10 — Prove design intelligence

Run:

```bash
npm run demo:reset -- design
```

In Codex:

```text
Use $autonomous-qa to run checkout-design --env local. Compare the declared confirmation checkpoint with its explicit reference.
```

Show that checkout still functions, but the confirmation action appears before the heading and the approved green success treatment becomes a red warning panel. In the result, show the declared viewport, reference provenance, actual screenshot, and concrete order/style findings.

Say:

> Functionality passed. The separate, explicit design checkpoint failed with reference-backed findings, so the result is `design_regression` rather than an agent opinion.

### 4:10–4:45 — Show inspectability and coverage

Run:

```bash
npm run qa-agent -- result list
npm run qa-agent -- last
npm run test:coverage
```

Open `.qa/runs/<run-id>/result.json` briefly or keep the result detail visible in the UI.

Say:

> Specs, results, screenshots, and the last-run pointer are ordinary repository files. The UI is optional. Ninety-seven tests enforce the storage guards, immutable expectations, healing boundary, result taxonomy, design evidence, reset states, and localhost UI.

### 4:45–5:00 — Close on the differentiator

Say:

> That is the complete developer loop: install, describe intent, run through the native browser, recover harmless drift, and keep real regressions visible. Intent survives UI churn; correctness does not get negotiated away.

## What not to do live

- Do not run bare `qa-agent run` and imply that it drove a browser. Without the Codex native capability it correctly saves `blocked`.
- Do not change the YAML between the pass, drift, and functional runs.
- Do not call the moved control “healed” until the original expectation has passed after the retry.
- Do not call a visual difference a regression without showing its explicit reference and concrete finding.
- Do not show or type fixture secrets while screenshots are being captured.
- Do not wait silently. While Codex is executing, narrate the current fixture, intent, expectation, and evidence checkpoint.

## Recovery lines

- If a server is already running: “The local target is already healthy, so the environment resolver reuses it rather than starting another process.”
- If native Browser is unavailable: “The runtime blocks instead of fabricating execution; I’ll reconnect the native browser and rerun the same spec.”
- If a run takes longer than expected: open the UI and explain that only completed, validated result files appear.
- If the design connector is unavailable: show that the declared design check becomes `blocked`, never an unsupported pass.
