# Judge demo runbook

This is the exact live-demo script for the current product. The story is simple: the developer installs one skill, stays inside the demo application project, and asks for QA in natural language. The skill owns setup, planning, browser execution, evidence, reruns, and the local review workspace.

The primary presentation is five minutes, including a 15-second safety margin. Rehearse it against a clean `qa-shop-demo` project before presenting.

## What the judges should understand

By the end of the demo, the judges should have seen that:

1. The developer installs one skill and adds no QA framework to the application.
2. The **Console** takes a URL, intent, every orchestration flag, and disposable demo credentials, then creates a `$autonomous-qa` request. It does not run the app.
3. A cold request is decomposed into bounded, route-owned work with visible coverage.
4. The skill drives the real application through a native browser and saves file-backed evidence.
5. An exact repeat still checks the live application, while compatible planning artifacts can be reused safely.
6. Semantic YAML remains human-reviewable; generated replay artifacts remain derived and replaceable.

## Judge scorecard from the official brief

Spend demo time in proportion to the published evaluation weights:

| Criterion | Weight | Proof in this demo |
| --- | ---: | --- |
| Functionality and completeness | 30% | One URL starts the uninterrupted Planner -> gate -> Generator -> execute -> Healer/report lifecycle |
| Innovation and originality | 20% | Coverage-gated replanning, safe history reuse, and defect-vs-script classification |
| Technical implementation and code quality | 20% | Schema validation, route ownership, bounded concurrency, immutable expectations, and file-backed evidence |
| User experience and demo clarity | 15% | Install one skill, remain in the demo project, compose and inspect through Console |
| Business impact and feasibility | 10% | No QA framework or coordination workflow is added to the developer's application |
| Presentation | 5% | Follow the hard timings and state limitations directly |

The URL is the sole required input. Username, password, intent, PRD, and advanced flags are optional; they are populated in the prepared local demo only to make the richer path visible.

## Presenter preflight — do this off camera

1. Create a separate clean project named `qa-shop-demo` from this repository's `demo-app/` directory.
2. Confirm that its initial tree contains only the demo application files. Do not copy this repository's `.qa/`, `node_modules/`, or root package files.
3. Confirm Node.js 20 or newer and a native Browser or Chrome capability are available.
4. Use the demo application's disposable `demo` / `demo` account. These values are intentionally visible during the presentation and must never be reused outside the local demo.
   The host may require a one-time confirmation before a native browser types even public demo credentials. That pause is a host safety boundary, not a blocked QA result. Confirm it during preflight, then validate and retain the trusted replay so the judge-facing repeat runs unattended. Do not promise that the skill can suppress a confirmation required by the host.
5. Install the skill once:

   ```text
   $skill-installer Install https://github.com/sudip-mondal-2002/auto-qa/tree/main/.agents/skills/autonomous-qa
   ```

6. Open a fresh Codex task rooted at `qa-shop-demo` and submit:

   ```text
   $autonomous-qa Set up the local QA workspace for this application at http://127.0.0.1:3000 and open the workspace. Do not run a product journey yet.
   ```

7. Arrange three visible surfaces: the Codex task, the application/browser, and the local QA workspace.
8. In the workspace, open **Console** and leave the target URL as `http://127.0.0.1:3000`.
9. Keep one prepared, validated passing run available only as a timing fallback. If you use it, explicitly call it prepared evidence.
10. Reset the application to `pass`, then stop it. This lets the live run prove that the skill can discover and start the application's own dev command.

If the organiser provides an official application URL and credentials, replace only **Target URL**, **Username**, and **Password** in Console. Keep the objective and correctness gates intact. Use the familiar local demo target if the official target is unavailable; the brief explicitly permits teams to bring their own test application.

## Primary five-minute demo

### 0:00–0:25 — State the promise

Show the clean `qa-shop-demo` tree and its `package.json`.

Say:

> The developer installs one skill and works only in the application project. There is no QA package, runner script, service, or database added to this app. The skill owns QA end to end.

Do not open this implementation repository after this point.

### 0:25–0:55 — Create the request in Console

1. Open **Console** in the local QA workspace.
2. In **Target URL**, enter:

   ```text
   http://127.0.0.1:3000
   ```

3. Select **Full coverage**.
4. Expand **Orchestration flags** and briefly show that every supported flag has a field.
5. Leave **Username** and **Password** as `demo`. Tell the judges these are disposable demo-app credentials and are intentionally visible in both Console and the generated request.
6. Leave the remaining safe defaults unchanged for the primary demo.
7. Show the generated request preview beginning with `$autonomous-qa`, the visible `--username demo --password demo` values, and the explicit default concurrency/replan/revision options.
8. Select **Copy request**, paste it into the Codex composer, and submit it.

Say:

> Console captures the URL, the outcome, every orchestration flag, and disposable demo credentials. It composes a request for the installed skill; it is not a second runner.

### 0:55–1:50 — Narrate the cold autonomous run

As the request progresses, point out these checkpoints without interrupting it:

1. The skill inspects the application and finds its existing start command.
2. It probes the loopback target and starts the app when needed.
3. Planner workers turn discovered evidence into meaningful success, edge, and error journeys.
4. The coverage critic identifies missing flows before Generator is allowed to produce executable tests.
5. Generator compiles validated semantic expectations and live-checked interaction targets.
6. Route ownership bounds concurrency so two workers do not mutate the same journey.
7. The native browser executes the real user flow; failures alone enter Healer/triage, which must distinguish script drift from a genuine product defect.
8. Reporter saves scenarios, outcomes, healer actions, remaining gaps, untested risks, screenshots, and observations.

Say:

> This is the required autonomous lifecycle: Planner, coverage gate, Generator, execution, failure-only Healer, and final quality report. No human directs the transitions between those stages.

If execution reaches the 1:50 hard stop, switch to the prepared passing evidence and say that you are doing so. Do not wait silently.

### 1:50–2:45 — Show correctness and evidence

Return to **Console**.

1. Show the stage tracker and the final coverage score. If an earlier planning attempt remains visible, call it **Planning incomplete**, then switch to **Workspace** for completed test outcomes; do not describe a stopped planning artifact as a blocked execution.
2. Show the route table: route owner, generated spec, status, and evidence.
3. Open the latest result.
4. Show the original expectations beside the observations.
5. Show one screenshot and its saved path under `.qa/runs/<run-id>/`.
6. Briefly open the generated semantic YAML and point out that it contains intent and expectations, not selectors or browser code.

Say:

> The UI is reading repository files. The requirements, observations, screenshots, and classification remain inspectable after the agent is gone. A pass is accepted only after the declared expectations and coverage gate succeed.

### 2:45–3:25 — Submit an exact repeat

1. In **Console**, select **Exact repeat**.
2. Select **Copy request** and submit the generated `$autonomous-qa` request in Codex.
3. Show that the skill recognizes compatible history and recommends the existing spec.
4. Let it execute the recommended spec against the live app.

Say:

> An exact repeat can reuse compatible planning artifacts, but never a previous verdict. The current application is still probed and the journey still executes live.

Do not claim that a second orchestration record is created if the history route directly runs a recommended spec. The fresh run result and history decision are the evidence for this path.

### 3:25–4:05 — Show the fresh repeat result

1. Open **Workspace**.
2. Select the fresh run.
3. Show its current timestamp, classification, observations, and screenshot.
4. Point out the history/reuse decision if it is present.

Say:

> The repeat reused only compatible derived work. This result is fresh evidence from the current application, not a cached pass.

### 4:05–4:35 — Explain the artifact boundary

Show one semantic spec and, if available, its derived replay artifact.

Say:

> The YAML expresses durable intent and remains reviewable in source control. Replay data is derived, fingerprinted, and replaceable. If compatibility changes, the system returns to the cold path instead of forcing stale automation.

### 4:35–4:45 — Close

End on the Console coverage summary or the fresh passing result.

Say:

> The developer installed one skill and stayed in the product repository. Autonomous QA handled planning, execution, evidence, safe reuse, and review without weakening the original requirement.

Stop. The remaining 15 seconds are recovery margin, not extra feature time.

## Optional capability demos

Run these only after the primary story or when a judge asks. Keep `npm run dev` running in the separate `qa-shop-demo` project, then use a second terminal for scenario resets.

### Demo A — Harmless interaction drift

1. Run:

   ```bash
   npm run reset -- drift
   ```

2. In Console choose **Healing evidence**, copy the request, and submit it.
3. Show that **Proceed to checkout** has changed to the equivalent **Checkout options** → **Continue to payment** route.
4. Show the one bounded retry, before/after screenshots, unchanged expectation, and final `healed` classification.

Say:

> The interaction changed, not the requirement. One evidence-backed equivalent retry recovered the journey without editing the expectation.

Stop if the expectation changes or more than one retry is used; that is not valid healing.

### Demo B — Functional regression stays red

1. Run:

   ```bash
   npm run reset -- functional
   ```

2. Submit the same rerun request without changing expectations.
3. Show that **Place order** succeeds but the application reports **Order could not be completed**.
4. Show the unchanged confirmation expectations and `functional_regression` classification.

Say:

> The action worked and the required business outcome failed. There is nothing to heal, so the regression stays red.

### Demo C — Reference-backed design regression

1. Run:

   ```bash
   npm run reset -- design
   ```

2. Submit:

   ```text
   $autonomous-qa Create or update checkout-design for the checkout journey. At confirmation, compare a 1280 by 900 viewport with the approved reference at http://127.0.0.1:3000/reference/approved-confirmation. Run it now, keep functional and design decisions separate, and show the findings.
   ```

3. Show that the functional journey passes.
4. Show the explicit reference, actual screenshot, declared viewport, concrete visual findings, and `design_regression` classification.

Say:

> Functionality passed. Design failed separately because explicit comparison evidence supports the finding; the agent is not grading by taste.

Without both reference and actual evidence, the correct result is `blocked`.

### Demo D — Coverage-gate refusal

For a maintainer-level technical walkthrough from this implementation repository, run:

```bash
npm run demo:corners -- --case P3
```

Show that incomplete route coverage is rejected rather than presented as a successful orchestration. Use `H7` for history incompatibility or `E5` for execution-edge behavior when a judge asks about those boundaries.

## Hard-stop recovery plan

| Situation | Do this immediately | Say this |
| --- | --- | --- |
| GitHub installation is slow | Show the prepared successful installer response and continue in the already-open app task. | “This is prepared installation evidence; the remaining run is live.” |
| Cold execution exceeds 55 seconds | Switch to the prepared validated passing result. | “I am switching to prepared evidence at the timing boundary.” |
| Port 3000 is occupied | Stop only the known demo process, or use the already configured healthy loopback URL. | “I am preserving unrelated processes and using the configured target.” |
| Browser capability is unavailable | Show the honest `blocked` result. | “Without a native browser, the system refuses to simulate a UI pass.” |
| Drift changes an expectation | Stop the demo. | “That crosses the healing boundary and is a correctness defect.” |
| Design comparison evidence is missing | Show `blocked`. | “A design verdict requires an explicit reference and actual evidence.” |
| Console is unavailable | Open the result files directly under `.qa/`. | “The files are authoritative; the UI is an optional reviewer.” |

## Exact answers for likely judge questions

**Is Console another test runner?**

No. It accepts a URL and intent, composes `$autonomous-qa` requests, and renders file-backed evidence. The installed skill owns execution.

**Where are credentials entered?**

For this presentation, the disposable `demo` / `demo` values are entered directly in Console and appear in the generated request. Production or reusable credentials must use environment references outside this demo flow and must never be shown.

**Are passes cached?**

No. Compatible planning or replay artifacts may be reused, but a new run probes and executes the current application and creates fresh evidence.

**What prevents agents from duplicating work?**

The planner partitions work by owned route, limits concurrency, validates generated documents, and applies a coverage gate before accepting completion.

**What can self-healing change?**

Only interaction mechanics with explicit equivalence evidence and one bounded retry. It cannot rewrite the expected product outcome.

**What is committed to the product repository?**

Human-reviewable `.qa/` environments, fixtures, and semantic specs. Run evidence and derived artifacts follow the repository's chosen retention policy.

**What are the current limitations?**

Discovery is primarily fetch/HTML based, similarity matching is lexical, and cross-process locking remains future work. These limits are preferable to hiding uncertainty behind a false pass.

## Non-negotiable presentation rules

- Never use a real account or reusable secret. The visible `demo` / `demo` credentials belong only to the disposable local demo application.
- Never use a URL dropdown; enter the actual target URL in **Target URL**.
- Never call the tab “Demo console”; its name is **Console**.
- Never show the internal launcher as a developer command.
- Never add a QA dependency or script to `qa-shop-demo`.
- Never put selectors, XPath, coordinates, browser scripts, or fixed sleeps in semantic specs.
- Never change expectations between the passing, drift, and functional runs.
- Never call a run `healed` without equivalence, one retry, unchanged expectations, and before/after evidence.
- Never make a design verdict without an explicit reference, actual screenshot, declared viewport, and concrete finding.
- Never hide `blocked` or failed evidence to protect the presentation.
