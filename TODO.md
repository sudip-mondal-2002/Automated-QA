# TODO — gaps between what exists and what the brief needs

Scope note: this file assumes **everything in `exp_1.md` "Next" is already done** by another
developer (live-verified Playwright batch, `unauth-redirect` session isolation, replan demo,
coverage sweep, merge/logistics). Nothing here duplicates that list.

Reference: `problem_explanation_9dm9yp4f98s.pdf` — Aivar / Bessemer Tech Catalyst,
*Autonomous Test Orchestration Agent*. Rubric weights are quoted where a gap maps to one.

Everything marked **[verified]** was reproduced locally on Windows 11 / Node 20 on
2026-09-04 against `demo-app` on port 4555, workspace in a scratch root.

---

## Done (2026-09-04) — LLM planner spike

Landed and verified live against Groq. Suite: **155/160 pass**, the 5 failures are the
pre-existing Windows-portability ones in 3.9, unchanged.

- `src/llm.js` — provider-agnostic client (OpenAI-compatible / Anthropic / Gemini), zero new
  dependencies, ajv-validated responses, repair retry, structured-mode and token-cap downgrade,
  full call logging. Key never enters a log or trace.
- `src/planner-llm.js` — LLM Planner emitting prose **and** a checkable predicate per
  expectation. Falls back to the deterministic planner and records `plan.source.fallbackReason`.
- `schemas/test-plan.schema.json` — the plan contract (closes part of 4.1).
- `src/generator.js` — fixes **0.1**, **0.2**, **0.3**: predicates compile to real assertions,
  expectations with no predicate emit an `UNVERIFIED` comment instead of a self-asserting one,
  form inputs are filled, `authenticated` flows call a generated `signIn()` helper, and
  assertion validation is real (text probed against page copy, `url_contains` probed against
  crawled paths).
- `src/orchestrator.js` — fixes **0.4** (executes `generation.artifacts`, not `slice(-N)`) and
  **0.5** (a clean run is no longer labelled `broken_locator`); tracer seeded with secrets.
- `scripts/compare-planners.mjs`, `--llm / --model / --provider / --plan-only`, `test/llm.test.js`
  (13 tests).

Measured on `demo-app`, same crawl, same prompt:

| planner | flows | steps | multi-step | fills inputs | expectations | with predicate | gate | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deterministic | 11 | 11 | 0 | 0 | 22 | 0 | 0.90 | pass |
| llm (gpt-oss-120b) | 7 | 19 | 6 | 6 | 25 | 25 | 0.50 | escalate |

Assertion validation on the LLM plan: 23/23 expectations carry a predicate, 22 statically
checkable, **18 verified, 4 refuted** — and all 4 refuted strings are ones the model had itself
listed under `openQuestions`.

Still open from that spike: **1.7** and **1.8** below.

## Done (2026-09-04) — Windows portability

Ships with the product; see 3.9 for the table. Four of the five Windows test failures were real
product bugs (orphaned dev servers, an SMB-reachable design reference, no Windows launcher, and
`.cmd` editors failing to spawn), not test noise. Suite on Windows: **161/162 pass, 0 fail**.

One further bug surfaced only when running end-to-end through the Windows launcher: the LLM
planner emits `fill` steps with no expectation, which the spec contract rejects
(`expect` `minItems: 1`). Fixed with `mergeActionSteps()` — an action-only step folds into the
step that asserts its outcome, carrying its inputs; a cross-page or trailing one is kept and made
assertable. `bindLocators` no longer indexes into `flow.steps`, which stopped lining up once
steps merge.

---

## P0 — Correctness bugs that will show on stage

### 0.1 Generated tests assert the *description* of an expectation as literal page text **[verified]**
`src/generator.js:10` `expectationToPlaywright()` compiles the expectation string into
`getByText(/<the expectation string>/i)`. Actual emitted code:

```js
test('Place order', async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  await (await resolve(page, chain.bindings[0].candidates)).click();
  await expect(page.getByText(/The submitted outcome is visible/i).first()).toBeVisible();
});
```

The app will never render the words "The submitted outcome is visible". Every generated
happy-path assertion is guaranteed to fail. Worse, negative expectations invert:
`unauthenticated-redirect.spec.js` asserts `getByText(/No protected data is shown/i)` is
**visible**.

Fix: expectations must carry a machine-checkable predicate, not only prose. Either
(a) the planner emits `{ prose, assert: { kind: 'text'|'url'|'absent'|'count', value } }`, or
(b) an LLM compiles prose → predicate against the observed DOM at generation time. Prose stays
the human contract; the predicate is what executes.

### 0.2 Generated tests skip auth and never fill inputs **[verified]**
`flow.preconditions: ["authenticated"]` is planned and then dropped on the floor —
`renderPlaywrightSpec()` never reads it. `bindLocators()` binds only the submit button, never the
form inputs. So the generated "happy path" for `/checkout` navigates unauthenticated, clicks
*Place order* on an empty form, and asserts a placeholder string. It is testing the empty-form
error case while claiming to test the happy path.

Fix: `preconditions` must resolve to a reusable auth setup (Playwright `storageState`, or a
`before` fixture); `bindLocators` must bind every input in the form with a value source.

### 0.3 "Live selector and assertion validation" — assertion validation does not exist **[verified]**
`bindLocators()` hardcodes `assertionValidated: true` (`src/generator.js:66`). `validateSelectors()`
only flips it false inside a `catch`. The selector "validation" itself is
`html.toLowerCase().includes(needle.slice(0, 12))` — a 12-character substring match against
fetched HTML. `validated: true` in every emitted sidecar means "12 chars appeared somewhere in
the source", not "this locator resolves" and never "this assertion holds".

This is a **Must Have** in the brief. Fix: resolve every locator in a real browser page and
evaluate every assertion predicate against the live DOM before stamping `validated`.

### 0.4 `slice(-N)` executes the wrong specs when the workspace has any pre-existing spec **[verified]**
`src/orchestrator.js:135` — `specs.slice(-generation.specs)` over `listSpecs()`, which sorts
**alphabetically by id** (`src/storage.js:315`). Reproduction: drop one hand-written
`zzz-my-own-test.yaml` into `.qa/specs/`, re-run `orchestrate`. Result:

```
blocked  flow_dashboard-view
skipped  flow_cart-view          <-- never executed, silently
blocked  flow_invalid-format
```

`cart-view` (alphabetically first) fell off the window; `zzz-my-own-test` was executed in its
place and discarded from the report because no flow matched it. On a clean demo workspace this
hides completely.

Fix: iterate `generation.artifacts` / `flowMap` directly. Never re-list the shared directory.

### 0.5 Passing scenarios are labelled `broken_locator` in the report **[verified]**
`src/orchestrator.js:143`:
```js
const triaged = status === "failed" ? "app_defect" : status === "blocked" ? "environment" : "broken_locator";
```
`passed` and `healed` both fall to the `else`. `report.md` renders clean runs as
`[passed/broken_locator]`. Judges read this file.

### 0.6 `triage()` is dead code
`src/locator-chain.js:32` holds the whole broken_locator / app_defect / flaky / environment
classifier with confidences. It is unit-tested (`test/orchestrate.test.js:23`) and drawn in
`docs/architecture.md`. **Nothing calls it.** Defect classification is a scored bonus item in the
brief; right now the implementation of it is unreachable.

### 0.7 Orchestrate writes generated specs into the user's `.qa/specs/`
Generated artifacts and hand-authored artifacts share one namespace, which is what makes 0.4
possible and means a second `orchestrate` run silently overwrites a developer's spec of the same
id. Generated output belongs under the orchestration directory, or under a reserved
`.qa/specs/generated/` prefix with `_generated: true` provenance in the document.

---

## P1 — The pipeline does not survive a target it has not seen

### 1.1 Any JS-rendered app collapses to one flow and escalates **[verified]**
`crawl()` is `fetch`-only and `parseHtml()` is regex over raw HTML. Simulated a React-shaped
shell (`<div id="root"></div>` + script tag):

```
flows: 1  [ 'happy/View /' ]
score: 0.4
checklist: happy-path=skipped error-per-form=skipped auth-negative=skipped
           assertion-density=pass category-mix=FAIL prompt-honored=FAIL
           edge-boundary=skipped orphan-page=pass destructive=skipped prd=skipped
verdict: escalate
```

The brief says *"The agent should work against any web application"* and the organiser hands over
a URL on the day. Today, any SPA is a guaranteed escalate with a one-line plan.

Fix: crawl through a real browser page (the Playwright adapter already exists) and read the
**accessibility tree**, not regex'd HTML. Fall back to fetch only when no browser is available,
and say so in the report.

### 1.2 The replan loop can structurally never fire from the two rules most likely to fail
`checkCategoryMix` and `checkPromptHonored` return `gaps: []`. `decideVerdict()` treats a blocking
failure with no gaps as `hasUnfixableBlocking` → **escalate**, skipping the loop entirely. Only
4 of 10 rules ever emit a `suggestion`. `exp_1.md` gap #2 notes replan was never observed live —
this is the structural reason, not bad luck.

Fix: every blocking rule must emit an actionable gap, or be demoted to advisory. Better: replace
`replan()`'s "append the precomputed suggestion" with a planner call that receives the gap list
as *feedback* and re-plans with it.

### 1.3 Crawl signals are computed and then thrown away
- `siteMap.degraded` (`src/planner.js:217`) — never read anywhere.
- `siteMap.auth.authenticated` — never read. **If login silently fails, the crawl proceeds
  anonymously, the plan is built from the logged-out surface, and nothing in the report says so.**
- `plan.openQuestions` — reaches `test-plan.md` only; never the gate, never `report.json`.

These are exactly the "ambiguity handling" signals the Innovation criterion (20%) asks about, and
they are already computed. Wire them into the gate and the report.

### 1.4 No multi-step journeys
`planToSpecs()` maps one flow → one spec → one step. There is no cart→checkout→confirmation
sequence anywhere in generated output. `exp_1.md` gap #5 flags this as paused; it is the single
biggest gap between "meaningful user flows" (Must Have) and what is produced.

### 1.5 No per-spec session isolation
One `page` is reused across every spec in `scripts/run-with-playwright.mjs`. Auth state leaks
between scenarios, which is why `unauth-redirect` cannot pass. Needs a fresh
`browser.newContext()` per spec — which is also the prerequisite for parallelism.

### 1.7 The coverage gate scores plan *shape*, not test *quality* **[verified]**
The comparison table above is the finding: the LLM plan is better by every quality measure
(6 multi-step journeys vs 0, fills inputs vs never, 100% checkable predicates vs 0%) and the gate
scores it **0.50 → escalate** against the deterministic plan's **0.90 → pass**.

Why it misfires:
- `category-mix` demands edge ≥ 15%. The LLM consolidated 11 shallow flows into 7 real journeys,
  so a legitimately better plan trips a ratio rule.
- `assertion-density` counts expectations per step, so a `fill` step — which correctly asserts
  nothing — is scored as "thin".
- `happy-path-coverage` and `orphan-page` penalise deliberately ignoring `/chat` when the
  developer's prompt said "focus on checkout and authentication". The gate contradicts the
  prompt the planner was told to honour.
- Nothing scores whether an expectation is *checkable*, which is the one thing that determines
  whether the suite can pass.

Fix: rebalance toward outcomes — reward predicate coverage, multi-step depth, and input binding;
make ratio rules advisory; exempt no-assertion action steps from density; and stop penalising
pages the prompt deliberately scoped out. Then add the model-judged rubric pass (2.1 item 2).

### 1.8 The crawl never reaches post-action pages, so success assertions are guesses **[verified]**
`/confirmation` is only reachable after POSTing checkout, so it is absent from the site map. The
planner therefore has no observable text for the single most important assertion in the suite —
the success state — and invents one. Live run: it produced `/order-confirmation` (real path:
`/confirmation`) and `"Thank you for your order"` (real heading: `"Order confirmation"`), while
simultaneously listing both under `openQuestions`. Prompt instructions alone did not stop it.

Assertion validation now *catches* this (4 refuted), which is the honest floor. The real fix is
to close the loop: feed refuted predicates back to the planner along with the actual page content
once execution has reached that page, and re-emit. That is also the replan demo that 1.2 says has
never fired — a genuine, observable "gate found a problem → agent re-planned → assertions now
verify" beat.

### 1.6 No run-level budget or timeout
`executor.act()` / `observe()` are awaited with no deadline. `signal` is checked *between* steps
only. A hung target hangs the pipeline forever with no partial report.

### 1.9 The crawl files a redirected page under the requested path, not the final one **[verified 2026-09-04, shelved]**
`crawl()` records each page under the path it *asked for* rather than the path it *landed on*.
On `demo-app`, `/` 303s to `/login`, so the site map reads:

```
/            forms=1  Sign in        <-- this is /login's form
/dashboard   forms=0
/cart        forms=0
/chat        forms=1  Ask for the refund policy
/checkout    forms=1  Place order
```

There is no `/login` entry at all. Consequences, both verified:

- A plan that correctly names `page: "/login"` finds no form there, so `bindLocators` builds no
  locator chain and falls back to a single `text` candidate made from the step intent — which
  never matches. Live: `login-rejects-invalid-credentials` emitted `strategy=text`, one candidate,
  `locatorsResolved: 0`, and the spec stayed unvalidated despite **2/2 assertions verified**.
- The deterministic planner is equally affected: its login flows are attributed to `/` too, so
  `happy-path-coverage` and `error-state-per-form` are scored against the wrong page.
- `/dashboard` and `/cart` show `forms=0` for the same reason — they redirect while anonymous, and
  the crawl records the redirect target's body under the requested path.

Root fix: record the final URL after redirects (`response.url`) as the page path, and keep the
requested path as an alias so link-graph edges still resolve. Cheap patch, if the crawl change is
too risky: let `bindLocators` locate a form by input names anywhere in the site map when the named
page has none.

Deferred deliberately — the recorded fixtures in `test-support/fixtures/` encode the current
(wrong) paths, so a crawl change means re-recording them, and P3 generator tests read those
fixtures rather than re-crawling.

---

## P2 — The brief asks for an agent; this is a rule engine

The rubric spends **40%** on *"how intelligently the orchestrator handles coverage gaps,
ambiguity, and failure classification"* (20%) and *"robustness of the agentic loop, quality of
generated tests, and depth of the healer"* (20%). The brief also states LLM API keys are the
team's responsibility — LLM usage is assumed, not optional.

Today there is **zero LLM in the repository** (verified: no `anthropic|openai|claude|llm|model`
match anywhere in `src/`, `scripts/`, `.agents/`, `package.json`). Every decision is a regex, a
keyword table, or an `if` tree:

- `PROMPT_ALIASES` (`src/planner.js`) hardcodes exactly two topics — `checkout` and
  `authentication`, the two words used in the demo command. Any other prompt scores 0 on
  `prompt-honored`.
- `page.signals` are `lower.includes("card")`, `lower.includes("cart")`, etc.
- `draftSpec()` infers intent from `/check\s*out|purchase/` → `"Order confirmation is visible"`.

### 2.1 Put a model in the three decision seats, keep the rails
The current deterministic layer is the right *oracle*. It should not also be the *reasoner*.
Minimum viable change, in priority order:

1. **Planner** — hand the model the site map / a11y tree + prompt + PRD, get back flows with
   real intents, preconditions, ordered steps and **checkable predicates**. Validate the response
   against a JSON Schema; on invalid output, fall back to today's deterministic planner. Keeps the
   demo safe.
2. **Gate** — keep the 10 rules as a hard floor, then add a model-judged rubric pass ("would a
   senior QA engineer sign this plan off? what is missing?") whose findings become gaps with
   suggestions. This is what makes replan actually fire.
3. **Healer / triage** — give the model the failure, the DOM before/after, the locator chain
   attempts, console/network errors, and the original expectation; ask it to classify
   broken-locator vs app-defect with a rationale. Keep `createExpectationGuard` as the
   non-negotiable rail: the model may re-locate, never re-assert.

### 2.2 Make Planner / Generator / Healer actual sub-agents
The brief names three sub-agents coordinated by a meta-agent. Today they are three imported
modules called in a straight line. Even keeping them in-process, give each an explicit
`{ input, output, budget, retries, trace }` contract and emit sub-agent lifecycle events into
`trace.jsonl` — the "agent pipeline" has to be legible in the artifact, not just the diagram.

### 2.3 No parallel execution (Good-to-Have)
`for (const spec of ...)` — strictly sequential. Blocked on 1.5.

---

## P3 — Harness self-verification (what tests to add)

The current 25 test files verify *units*. Nothing verifies that **the harness as a whole produces
correct QA**. Bugs 0.1–0.5 all survived a green suite.

### 3.1 Seeded-defect confusion matrix ← highest value
Build a fixture app with a mutation switch (`demo-app` already has `DEMO_SCENARIOS`; generalise
it). Seed known defect classes with ground-truth labels:

| seeded mutation | expected classification |
| --- | --- |
| rename a button's text, behaviour intact | `broken_locator` → healed |
| remove the button entirely | `app_defect` |
| change confirmation copy | `app_defect` (never healed) |
| return 500 on submit | `app_defect` |
| add 2s render delay | `passed` (readiness wait) |
| allow double submission | `app_defect` on the guard flow |
| stop the server | `environment` |
| unchanged app | **zero** regressions |

Assert precision/recall per class. This directly produces the number to put on the slide for
"defect classification" (bonus) and "depth of the healer" (20%), and it is the only test that can
catch a healer that heals too eagerly.

### 3.2 Generated tests must actually execute
For every emitted `.spec.js`: assert it parses, then run it under Playwright against a **known-good**
app and assert it **passes**. Bug 0.1 and 0.2 would have failed this on the first run. A generator
whose output cannot pass against a working app is not validated, whatever the sidecar says.

### 3.3 Target-shape conformance suite
Fixture apps: SPA shell, auth-gated, multi-step wizard, paginated table, infinite-redirect,
self-referencing links, 5k-link page, form with no submit button, CSRF-token form, iframe,
shadow DOM, non-UTF8, gzip, slow (5s) responses. For each, assert the pipeline either produces a
sane plan **or degrades honestly** — never escalates with a one-line plan while reporting
`score: 0.9`.

### 3.4 Workspace isolation property test
Pre-seed the workspace with N hand-written specs; run `orchestrate`; assert (a) every generated
flow was executed, (b) no user spec was executed, (c) no user spec was modified or deleted.
Catches 0.4 and 0.7.

### 3.5 Secret-leak fuzz
Set every credential/env var to a unique sentinel, run the full pipeline including a failing and a
healing path, then grep **every** artifact — `trace.jsonl`, `site-map.json`, `report.*`,
`*.locators.json`, screenshots' metadata, event journal — for each sentinel. Assert zero hits.
Note `createTracer` in `orchestrator.js` is currently constructed with **no** `sensitiveValues`,
so the orchestration trace has no redaction wired at all.

### 3.6 Determinism / idempotence
Same target twice → byte-identical plan modulo timestamps and ids. Currently unverified; a
non-deterministic planner makes every other assertion in this list flaky.

### 3.7 Crash and resume
SIGINT mid-run; assert the workspace is not corrupted, a partial report exists, and the last-test
pointer still resolves. There is no resume path today at all.

### 3.8 Trace invariants
Every `stage_started` has a matching `stage_completed` or an explicit failure event; `seq` is
gapless and monotonic; every decision in `report.decisions` has a corresponding trace entry.

### 3.9 Cross-platform CI — **fixed 2026-09-04**, matrix still to add
Windows now runs **161/162 pass, 0 fail, 1 skipped** (the skipped one needs symlink privileges).
Four of the five original failures were genuine product bugs on Windows, not test noise:

| was failing | root cause | fix |
| --- | --- | --- |
| `core-boundaries` — stop idempotently | `stop()` used `child.kill("SIGTERM")` on win32, which kills the `cmd.exe` wrapper and **orphans the dev server holding the port** | new `stopProcessTree()` uses `taskkill /T /F`, falls back to `kill`, treats status 128 as already-gone; tested for both platforms via injection instead of monkeypatching `process.kill` |
| `design` — reference rejection | `file://example.com/x.png` is a legal **UNC path** on Windows, so a spec-supplied reference could reach out over SMB | file URLs naming a host are now rejected on every platform |
| `skill-package` | launcher is `#!/bin/sh`; nothing to run on Windows | added `scripts/qa-agent.cmd`; SKILL.md documents it plus the launcher-free `node scripts/qa-agent.mjs` form |
| `cli-coverage` — document operations | test hardcoded `/usr/bin/true`, **and** `editSpec` used `shell: false`, so any `.cmd`/`.bat` editor (how most Windows editors are shimmed) failed with EINVAL | `shell: true` on win32; test uses a generated platform-appropriate no-op |
| `workspace-boundaries` — access failures | `symlink()` needs Developer Mode | skipped with a reason via `canSymlink()` — it tests POSIX `ELOOP` propagation |

Also added `.gitattributes` so the esbuild bundle stops showing dirty on every Windows build.

Still to do: the actual win/mac/linux CI matrix, so this does not regress.

---

## P4 — Contracts, packaging, delivery

### 4.1 Orchestrator artifacts have no schema
`schemas/` covers `spec`, `fixture`, `result`, `environments`, `lastTest` — all Layer A.
`test-plan.json`, `gaps.json`, `report.json`, `site-map.json`, `*.locators.json`, `trace.jsonl`
have **no schema and no validation**. These are the artifacts the brief is graded on, and they are
the unvalidated ones. Add schemas and run `validateDocument()` before every write — this also
becomes the contract an LLM planner's output is checked against (see 2.1).

### 4.2 The trace UI is backend-only
`GET /api/orchestrations/:id/trace` exists (`src/ui-server.js:276`). `ui/app.js` contains **zero**
references to orchestrations or traces. The "decision timeline" in `docs/architecture.md` has no
frontend, and there is no way to start an orchestration from the UI — it is CLI-only.
"User experience and demo clarity" is 15% of the score. Build the timeline view: stages, gate
decisions with scores, replan events, per-scenario triage, PRD gaps.

### 4.3 Two products, one repo, one README
`main` sells a *one-skill developer experience* (describe a journey → semantic YAML → native
execution → design regression). The brief asks for *URL in → test suite out*. `orchestrate` is the
submission; the skill is infrastructure it reuses. Right now `README.md` leads with the skill and
buries `orchestrate` at line 203. Restructure so the brief's pipeline is the headline, with the
semantic-contract layer presented as the thing that makes the output trustworthy.

### 4.4 Delivery must not depend on the judge's agent harness
Submission requires *"the orchestration agent running live on a target application"* and *"clear
setup instructions"*. A Codex/Claude skill runs only inside that harness. Ship a standalone
entrypoint — `npx . orchestrate --url ... --model ...` with an API key — as the primary path, and
keep the skill packaging as an additional integration.

### 4.5 Sample specs in `.qa/specs/` read as hand-written test scripts
The brief lists *"Manually written test scripts"* under **Out of Scope** — "all test behaviour must
be produced by the agent pipeline". `checkout-card.yaml`, `checkout-design.yaml`,
`checkout-saved-card.yaml` are committed hand-written specs. They are demo fixtures for Layer A,
but a judge reading the repo cannot tell. Move them under `examples/` and label them.

---

## Model selection note (measured, not assumed)

Groq, 2026-09-04, identical prompt and crawl:

| model | structured output | result |
| --- | --- | --- |
| `openai/gpt-oss-120b` | `json_schema` strict — supported | 7 flows, valid first attempt, ~11s |
| `groq/compound` | `json_schema` **rejected**; `json_object` only | 2× `Request Entity Too Large` on the schema payload, then ignored the schema and invented its own shape (`name` for `id`, `action: "visit"`, raw `selector` fields). Fell back. ~45s |

Strict schema enforcement is not a nicety — it is what stops a model freelancing the contract.
Prefer models that support it; `groq/compound`'s hosted tools are useless here anyway, since
`visit_website` runs on the provider's servers and cannot reach a local target (verified: *"You
do not have access to this site"*).

## Suggested order

1. ~~0.1 → 0.5~~ **done**; 3.2 next (the test that keeps 0.1/0.2 fixed — run the emitted specs
   under Playwright against a working app and require them to pass)
2. 1.8 predicate-refutation feedback loop — fixes the invented success assertions *and* gives
   1.2's replan demo a real trigger
3. 1.7 rebalance the gate, then 2.1 item 2 (model-judged coverage rubric)
4. 1.1 browser-based crawl — unlocks working against the organiser's URL at all
5. 2.1 item 3 LLM Healer, 1.5 session isolation → 2.3 parallelism
6. 3.1 seeded-defect matrix — the slide number
7. 4.2 trace UI, 4.3/4.4 packaging and README
8. rest of 4.1 schemas, remaining P3 tests, 3.9 cross-platform CI
