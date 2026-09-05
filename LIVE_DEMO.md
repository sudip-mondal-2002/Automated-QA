# Recorded-video timing script

This file preserves the timing and shots used by the existing 4:02 recording. For the current judge-facing workflow, including the integrated Console and visible disposable credentials, use [`demo.md`](demo.md). Do not use this older recording script as the live event runbook.

This is the exact developer-facing presentation. It begins with skill installation, stays inside a standalone application project, and proves both developer experience and correctness. The internal QA implementation repository never appears on screen.

Target: **4:50 of content with a 10-second safety margin**. The section end times below are hard stops. If native execution is still running at a hard stop, use the named proof tab and continue narrating; do not wait silently or speed-read the close.

## Preflight — off camera

1. Copy [`demo-app/`](demo-app/) to a clean directory named `qa-shop-demo`. Do not copy this repository's `.qa/`, `node_modules/`, or root `package.json`.
2. Confirm the standalone project contains only `package.json`, `server.js`, and `reset.js`.
3. Make sure `~/.codex/skills/autonomous-qa` is absent so the install step is real. If this is a repeated rehearsal, uninstall only that exact skill first.
4. Set `QA_CUSTOMER_USERNAME` and `QA_CUSTOMER_PASSWORD` in the Codex local environment off camera. Never type or display either value during the demo.
5. Save the clean `qa-shop-demo` directory as a Codex project. Open a task at that project root.
6. Keep the app stopped. The skill must demonstrate that it can discover and run `npm run dev` itself.
7. Prepare four browser tabs for fast switching after execution begins:
   - Codex task;
   - application target (the skill will open it);
   - QA workspace (the skill will open it);
   - this runbook, hidden unless recovery is needed.
8. Rehearse the browser journey once. Do not reuse its `.qa/` output; replace the demo directory with a clean copy afterward.

## On-screen sequence

### 0:00–0:18 — State the promise

Show the clean `qa-shop-demo` project tree and say:

> The developer installs one skill and stays in the application project. They describe the journey; the skill owns setup, app startup, native browser execution, evidence, reruns, and the results UI. It may recover harmless interaction drift, but it cannot rewrite correctness.

Hard stop: **0:18**.

### 0:18–0:45 — Install the skill

In a Codex task, submit exactly:

```text
$skill-installer Install https://github.com/sudip-mondal-2002/auto-qa/tree/main/.agents/skills/autonomous-qa
```

Point out the successful install destination and “available on the next turn.” Move to the already-open `qa-shop-demo` task for the next prompt.

Say:

> Installation copies one self-contained skill. The app does not add an npm dependency, QA script, service, or database.

Hard stop: **0:45**. If GitHub is slow, show the repository skill directory and the previously completed installer response; do not burn the demo budget retrying a network call.

### 0:45–1:05 — Prove the app is clean

Show `qa-shop-demo/package.json`. It contains only the app's `dev` and `reset` scripts and no dependencies. Do not run `npm install`—this demo app has nothing to install.

Say:

> This is the only project the developer works in. There is no QA package here. The skill carries its runtime, schemas, and reviewer UI with it.

Hard stop: **1:05**.

### 1:05–1:55 — One request sets up and runs QA

Submit exactly:

```text
$autonomous-qa Set up QA for this app and verify that a logged-in customer can complete checkout. Require the cart to contain one item, the checkout form to be visible, and the order confirmation to be visible with no error. Reuse login and cleanup fixtures, save screenshots, and open the evidence when the run finishes.
```

While the skill works, narrate its visible checkpoints instead of its internal commands:

- it discovers `npm run dev` and `http://127.0.0.1:3000`;
- it creates project-specific `.qa/` files rather than demo samples;
- it validates the selector-free intent and expectations;
- it starts the stopped app and connects native Browser;
- it runs login, cart, checkout, confirmation, and cleanup;
- it saves screenshots and opens the results UI.

Switch briefly to `.qa/specs/checkout-card.yaml` once it appears. Point only to intent, expectations, environment, and fixtures. Then show the live browser journey.

Say:

> One developer request produced a reviewable semantic test and executed it. There is no CSS selector, XPath, coordinate, fixed sleep, or browser script in the app project.

Hard stop: **1:55**. If execution is still active, switch to the prepared passing evidence tab and say, “The result only appears after the complete file validates.”

### 1:55–2:25 — Inspect passing evidence

In the workspace UI, select the new `passed` result. Show:

- the unchanged expectations;
- the observed accessible targets;
- the fixture and step screenshots;
- the result path under `.qa/runs/`.

Click **Copy rerun prompt** and show that it copies a `$autonomous-qa` request, not a runner command.

Say:

> The second UI is only a reviewer over repository files. It does not run an agent. Even its rerun action hands control back to the installed skill.

Hard stop: **2:25**.

### 2:25–3:10 — Heal harmless interaction drift

In the `qa-shop-demo` terminal, change only application state:

```bash
npm run reset -- drift
```

In Codex, submit:

```text
$autonomous-qa Rerun the last test. Keep every expectation unchanged and show any healing evidence.
```

Show “Proceed to checkout” moved under “Checkout options” and became “Continue to payment.” Then open the `healed` result and point to the failed original target, explicitly equivalent replacement, single retry, before/after evidence, and original checkout-form expectation.

Say:

> The interaction changed, not the requirement. One equivalent retry is allowed because the same visible outcome passes unchanged.

Hard stop: **3:10**.

### 3:10–3:45 — Keep a real product bug failed

Reset only the demo app:

```bash
npm run reset -- functional
```

Submit the copied rerun prompt again. Show “Order could not be completed,” then the new `functional_regression` result.

Say:

> The click worked, but the required outcome failed. There is no interaction to heal, so the agent keeps the regression red and leaves “Order confirmation is visible” untouched.

Hard stop: **3:45**.

### 3:45–4:20 — Keep design separate from function

Reset the demo app:

```bash
npm run reset -- design
```

Submit:

```text
$autonomous-qa Run the checkout design check. Keep functional and design decisions separate, compare the declared confirmation checkpoint with its explicit reference, and show the findings.
```

Show that checkout functionality succeeds, then show the red panel, reordered action/heading, explicit approved reference, actual screenshot, declared viewport, and concrete findings in the `design_regression` result.

Say:

> Functionality passed. The separate design check failed only because an explicit reference and the actual screenshot support concrete order and style findings—not because the agent disliked the page.

Hard stop: **4:20**.

### 4:20–4:50 — Close on developer experience and correctness

Show the `qa-shop-demo` tree with its generated `.qa/` directory, then return to the workspace summary containing `passed`, `healed`, `functional_regression`, and `design_regression` results.

Say:

> That is the complete loop from the developer's application project: install one skill, describe intent, let it own execution and evidence, survive harmless UI churn, and keep real product or design regressions visible. The app gained reviewable QA files, not an automation framework dependency.

Stop at **4:50**. Leave the final evidence overview visible for the remaining ten seconds if the event clock requires a full five-minute slot.

## Optional corner-case drill — after the five-minute demo

Keep this outside the timed developer story. It is the technical-Q&A path for
the full judgement matrix in [`docs/corner-test-cases.md`](docs/corner-test-cases.md).
From the implementation repository, run:

```bash
npm run demo:corners
```

The command verifies all 28 documented contracts with their focused evidence
tests. A judge can choose one instead of watching a fixed happy path:

```bash
npm run demo:corners -- --case H7
```

In the standalone `qa-shop-demo`, list every live mutation with:

```bash
npm run reset -- --list
```

The four timed beats already cover D1 (`pass`), H1 (`drift`), H3
(`functional`), and D4 (`design`). The optional live challenges add:

| Prompted challenge | Reset command | What must happen |
| --- | --- | --- |
| Removed action (H2) | `npm run reset -- missing-target` | no equivalent target; `functional_regression` |
| Failed fixture postcondition (H4) | `npm run reset -- fixture` | never heal; `functional_regression` |
| Heal, then fail later (H7) | `npm run reset -- drift-functional` | the later failure overrides the earlier heal |
| Cleanup failure (E5) | `npm run reset -- cleanup` | primary verdict stays `passed`; cleanup issue remains visible |

For the degraded-crawl challenge (P7), point a plan-only run at
`http://127.0.0.1:3000/spa-shell`. Keep the other capability-boundary cases in
the executable drill: they are runtime contracts, not fake application
mutations.

## Timing fallback table

| If this slips | Do this immediately | Never do this |
| --- | --- | --- |
| Install exceeds 27 seconds | Show the completed installer response and continue at 0:45 | Retry GitHub repeatedly |
| Initial run exceeds 50 seconds | Use the prepared passing evidence tab at 1:55 | Wait silently |
| Drift run exceeds 45 seconds | Show moved control, then prepared healed evidence at 3:10 | Change the test |
| Functional run exceeds 35 seconds | Show the broken outcome and prepared result at 3:45 | Call it healed |
| Design run exceeds 35 seconds | Show explicit reference and prepared findings at 4:20 | Claim a taste-based regression |

Prepared tabs are recovery aids only; normal presentation uses fresh results. State clearly when a prepared result is being shown because a live run exceeded its window.

## Non-negotiable demo rules

- Do not open the QA implementation repository after the installation chapter.
- Do not run or display `qa-agent`, `npm run qa-agent`, or `npm run ui` as developer steps.
- Do not run `npm install` in the dependency-free demo project.
- Do not type fixture secrets or capture credential fields while populated.
- Do not change the semantic expectations between pass, drift, and functional runs.
- Do not call recovery `healed` until the original expectation passes after the one equivalent retry.
- Do not call a visual difference a regression without an explicit reference, actual screenshot, declared viewport, and concrete finding.
- A missing native capability or design comparator is `blocked`, never an inferred pass.
