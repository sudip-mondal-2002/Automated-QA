# 10 — Known gaps and roadmap

Everything below is drawn from `TODO.md`, `exp_1.md`, `docs/corner-test-cases.md`
and direct verification against `d8199ad`. Grouped so you can answer *"what's
missing?"* without being caught out.

---

## 0. Closed by the PR #3 merge (`d8199ad`) — the newest changes

| Was a gap | Now |
| --- | --- |
| **No multi-step journeys from the deterministic planner** (old G3 / `TODO` 1.4) | `buildTestPlan` BFS-walks the observed link graph (≤ 2 hops) from the landing page and emits one `Open` step per hop, using **recorded link text** as the intent. Measured: **4 of 7 flows are multi-step**, e.g. `Open shopping cart → Proceed to checkout → Place order` |
| **Deterministic planner emitted no predicates** | `textExpect()` lifts assert values from crawled headings / button labels / link text; `absentExpect()` builds `absent_text` predicates from negations. Measured: **15/21 = 71 %** predicate coverage. A miss stays bare prose → `// UNVERIFIED`, never invented copy |
| **H4 — fixture postcondition failure reported as `blocked`** (old G7) | `execution.js` now splits `blocked` from `failed`: a genuinely failed postcondition is a **`functional_regression`**, never healed. Covered by a new test |
| **Bag-of-words observation could pass on the wrong page** | Observations now score against a **single semantic block** at ≥ 60 %, not the whole page at ≥ 50 % |
| **No locator-chain evidence at execution time** | The reference driver clicks `testid → role → text` and records the attempts in the selected target (`[chain: testid=place-order:miss -> role=Place order]`), plus a `(fuzzy 1/2)` receipt on partial matches |
| **Auto-navigation on step 1 discarded fixture state** | Removed; `connect()` navigates once, fixtures own the state after that |
| **Demo app could not be crawled or driven as an authenticated user across requests** | Cookie session (`qa-demo-session`) added, so a fetch cookie jar and a Playwright context both see authed pages |

Two consequences to state honestly rather than hide:

1. **The cold-run gate score went down, 0.95 → 0.7.** Fewer, deeper flows plus a
   deliberately cut flow (below) means two blocking rules now fail. The plan got
   better and the score got worse — which is the point of
   [slide 14](09-presentation-outline.md) and the reason a coverage score is a
   diagnostic, not a KPI.
2. **The `unauthenticated-redirect` flow was cut on purpose.** It needs a fresh
   logged-out browser context per spec; single-context runs cannot isolate sessions,
   so the flow *"would fail for infrastructure reasons and masquerade as product
   signal."* The blind spot is now carried in `plan.openQuestions` and surfaces in
   the report and the UI's *Declared unknowns* panel — but it costs the plan the
   `auth-negative` rule. See G8.

Also changed in the merge: `docs/ORCHESTRATOR_DEMO.md`'s 2:30 beat is now
*"it adapts without failing"* (renamed controls still resolve, every fuzzy
resolution leaves a receipt) with an explicit note that a live `healed` recovery is
unit-proven while **full cross-run sidecar promotion is scoped roadmap, not
claimed**; and `run-with-playwright.mjs` now passes `QA_TEST_CARD`
(default `4242…`, the value the demo shop advertises on its own checkout page).

---

## 1. Already fixed earlier — do not re-fix, but know the story

These are worth telling because each one is a class of bug that AI test tooling
routinely ships:

| Was | Now | Where |
| --- | --- | --- |
| Generated tests asserted the **description** of an expectation as literal page text — every happy-path assertion guaranteed to fail, and negative expectations inverted | Expectations carry `{prose, assert}`; `predicateToPlaywright` compiles real assertions; no predicate → `// UNVERIFIED` comment | `generator.js` |
| Generated tests skipped auth and never filled inputs — the "happy path" clicked *Place order* on an empty unauthenticated form | `preconditions: ["authenticated"]` resolves to a generated `signIn()` built from the crawled login form; every input is bound and filled | `generator.js` |
| `assertionValidated: true` was hardcoded; locator "validation" was a 12-char substring match | Locators and assertions are probed against the live page; unreachable pages leave the verdict `null`, not `true` | `validateSelectors()` |
| `specs.slice(-N)` over an alphabetically sorted directory executed the *wrong* specs whenever the workspace held any hand-written test | Executes `generation.artifacts` via `flowMap` | `orchestrator.js` |
| Clean runs were labelled `broken_locator` in `report.md` | Only a run that actually recovered from drift earns that label | `orchestrator.js` |
| The gate scored plan **shape**, so a better (consolidated, predicate-rich) plan scored 0.50/escalate against a worse plan's 0.90/pass | 12 rules, 6 advisory; `checkable-assertions` added; prompt-scoped pages downgrade to advisory | `coverage.js` |
| The orchestration tracer was constructed with **no** `sensitiveValues` — the trace had no redaction at all | Tracer seeded with username + password at construction | `orchestrator.js` |
| Prompt matching hardcoded aliases for the two words in the demo command | Generic keyword matching against the plan's own words | `coverage.js` |
| PRD title stole `REQ-1` and shifted every requirement; generic keywords caused false coverage | Title-block skip; requirement matching uses only the first three (most topical) keywords | `planner.js` |
| Four Windows-only product bugs (orphaned dev servers, SMB-reachable design reference, no Windows launcher, `.cmd` editors) | `stopProcessTree`, host-bearing `file://` rejected everywhere, `qa-agent.cmd`, `shell: true` on win32 | `environment.js`, `design.js`, skill scripts, `cli.js` |
| LLM planner spike (`src/llm.js`, `src/planner-llm.js`) put a provider client in the runtime | Replaced by `planner-agent.js` — a capability seat with a schema contract. **The runtime no longer contains any model client at all.** | `planner-agent.js` |

---

## 2. Open gaps, ranked by how likely a judge is to find them

### G1 — The crawl is fetch-only *(highest impact)*
`crawl()` uses `fetch` and `parseHtml()` is regex over raw HTML. A React-shaped
shell (`<div id="root"></div>` + a script tag) produces:
```
flows: 1  [ happy/View / ]     score: 0.4     verdict: escalate
```
Any SPA is a guaranteed escalate with a one-line plan.

**Mitigation today:** `siteMap.degraded` is computed and **is** surfaced in the
planner brief as an explicit warning with an instruction to record doubt in
`openQuestions`. So the system degrades *visibly*, not silently.
**Fix:** crawl through a real browser page and read the **accessibility tree**;
fall back to fetch when no browser is available and say so in the report. The
Playwright adapter to do this already exists.

### G2 — The crawl files a redirected page under the requested path
`/` 303s to `/login`, so the site map has a `/` entry containing `/login`'s form and
**no `/login` entry at all**. Consequences: a plan that correctly names
`page: "/login"` finds no form, `bindLocators` falls back to a single text candidate
built from the intent (which never matches), and `happy-path-coverage` /
`error-state-per-form` are scored against the wrong page.
**Fix:** record `response.url` after redirects as the page path and keep the
requested path as an alias.
**Why deferred:** `test-support/fixtures/` encode the current paths and the
generator tests read them; changing the crawl means re-recording.

### G3 — Journey depth is capped at 2 hops and depends on crawled link text *(largely closed)*
Fixed for the common case in PR #3 (see §0): the deterministic planner now BFS-walks
the observed link graph and emits real journeys — 4 of 7 flows on the demo app.
What remains: the walk is capped at **2 hops** from the landing page, it needs the
link to carry usable text, and a target reachable only through a form POST (like
`/confirmation`) still has no path — which is G4.

### G4 — The crawl never reaches post-action pages
`/confirmation` is only reachable after POSTing checkout, so the planner has no
observable text for the single most important assertion in the suite — the success
state — and tends to invent one (`/order-confirmation` for an app serving
`/confirmation`; "Thank you for your order" for a page headed "Order confirmation").
**Mitigation today:** assertion validation *catches* this — 4 refuted in the live
comparison, and the model had listed all four under `openQuestions` itself.
**Fix (and the best next feature):** feed refuted predicates back to the planner
along with the actual page content once execution has reached that page, and
re-emit. This is simultaneously the fix for G4 **and** the genuine trigger the
replan demo has never had.

### G5 — The replan loop still does not fire live
Unit-tested. The first structural cause (a blocking rule with no actionable gap
dead-ending into `escalate`) was fixed by requiring every blocking rule to name a
gap. A second one now dominates: on the current demo app the run escalates on
attempt 1 because `checkable-assertions` emits a gap marked `autoFixable: false`,
and `decideVerdict` escalates on **any** unfixable blocking failure before
considering a replan. A live replan beat needs a run whose blocking gaps are all
auto-fixable — e.g. a target missing a happy or error flow but with predicate
coverage already above 80 %.

### G6 — `triage()` is not wired in
`locator-chain.js` holds a full defect classifier — `broken_locator` 0.9,
`app_defect` 0.85–1.0, `flaky` 0.6–0.8, `environment` 0.6–0.95 — with an
expectation-guard trip pinned at confidence **1.0**. It is unit-tested and drawn in
`docs/architecture.md`, and **nothing calls it**. `orchestrator.js` computes a
simpler inline triage instead. Defect classification is a scored item; the good
implementation is currently unreachable.

### G7 — ~~Fixture postcondition failures report as `blocked`~~ **fixed in PR #3**
Kept here only so the fix is findable: `execution.js` now maps a `failed`
`before`/`between` fixture to `functional_regression` and only a `blocked` one to
`blocked`. Covered by *"H4: failed fixture postconditions are functional
regressions, never blocked or healed"*. See §0.

### G8 — No per-spec session isolation *(now a declared blind spot)*
`scripts/run-with-playwright.mjs` reuses one `page` across every spec, so auth state
leaks between scenarios. Needs `browser.newContext()` per spec, which is also the
prerequisite for parallelism.

**What changed in PR #3:** rather than shipping a flow that would fail for
infrastructure reasons and read as a product defect, the deterministic planner
**cut** the `unauthenticated-redirect` flow and records the limitation in
`plan.openQuestions`, where it reaches the report and the UI. That is the right
call, and it has a visible cost: the gate's `auth-negative` rule now fails, taking
the cold-run score from 0.95 to 0.7. Fixing G8 restores both the flow and the score.

### G9 — No run-level budget or timeout
`executor.act()` / `observe()` are awaited with no deadline; `signal` is checked only
*between* steps. A hung target hangs the pipeline indefinitely with no partial report.

### G10 — Generated specs share the developer's `.qa/specs/` namespace
Generated and hand-authored artifacts share one namespace, which is what made the
`slice(-N)` bug possible and means a second `orchestrate` run can silently overwrite
a developer's spec of the same id. Should live under the orchestration directory, or
under a reserved `.qa/specs/generated/` prefix with `_generated: true` provenance.
**Mitigated** by `.qa/specs/README.md` labelling the committed demo specs as
hand-authored, but not physically separated.

### G11 — Coverage gates are red
96.64 % lines / 82.77 % branches / 95.56 % functions vs declared 100 / 95 / 98.
Worst branch coverage: `reporter.js` 52.8 %, `planner-agent.js` 57.6 %,
`orchestrator.js` 61.8 %, `generator.js` 64.7 %. PR #3 added 9 tests but also added
branches faster than it covered them, so overall branch coverage dipped 0.3 pt.

### G12 — The sub-agents have no explicit budget/retry envelope
They have input/output contracts and lifecycle trace events, but no
`{ budget, retries, timeout }` per seat. The "agent pipeline" is legible in
`trace.jsonl`, but it is three imported modules called in a straight line, not three
independently governed agents.

### G13 — No crash-and-resume path
SIGINT mid-run leaves no partial report and no resume. Writes are atomic so the
workspace is not corrupted, but the run is simply lost.

---

## 3. Missing self-verification (the tests that should exist)

| # | Test | Catches |
| --- | --- | --- |
| 3.1 | **Seeded-defect confusion matrix** — 8 known mutations with ground-truth labels, assert precision/recall per class | A healer that heals too eagerly; produces the headline number for "defect classification" and "depth of the healer" |
| 3.2 | **Generated tests must execute** — run every emitted `.spec.js` under Playwright against a known-good app and require a pass | The entire 0.1/0.2 class of bug |
| 3.3 | **Target-shape conformance** — SPA, auth-gated, wizard, paginated, infinite-redirect, 5k links, CSRF, iframe, shadow DOM, non-UTF8, gzip, slow | Escalating with a one-line plan while reporting a high score |
| 3.4 | **Workspace isolation property test** | The `slice(-N)` and shared-namespace classes |
| 3.5 | **Secret-leak fuzz** with unique sentinels across every artifact | Proves the redaction claim end to end |
| 3.6 | **Determinism / idempotence** | A flaky planner makes every other assertion flaky |
| 3.7 | **Crash and resume** | G13 |
| 3.8 | **Trace invariants** — matched stage events, gapless `seq`, every report decision has a trace entry | Makes the decision log itself trustworthy |
| 3.9 | **Cross-platform CI matrix** | Stops the Windows fixes regressing |

The seeded-defect matrix (3.1) is the single highest-value addition: it is the only
test that can catch a healer that heals when it should not, and it produces a number.

---

## 4. Recommended order of work

1. **3.2** — run the emitted specs under Playwright against a working app. This is
   the test that keeps the biggest fixes fixed.
2. **G4 + G5** — predicate-refutation feedback to the planner. Fixes invented
   success assertions *and* gives the replan loop a real trigger. Two headline
   problems, one feature.
3. **Model-judged coverage rubric** on top of the 12 deterministic rules, whose
   findings become gaps with suggestions.
4. **G1** — browser-based crawl through the accessibility tree. This is what makes
   the agent work against an arbitrary application handed over on the day.
5. **G8 → parallelism** — per-spec browser contexts. This is now higher value than
   it looks: it restores the `unauthenticated-redirect` flow that PR #3 honestly
   cut, which un-fails `auth-negative` and lifts the cold-run score back up. Then
   concurrency.
6. **G6** — wire `triage()` into the report; it is already written and tested.
7. **3.1** — the seeded-defect confusion matrix.
8. **G9**, **G10**, **G11**, **G13**, then the CI matrix.

---

## 5. Answering the hard questions

**"Is there any AI in this at all?"**
The runtime is deliberately model-free — that is an architectural choice, not an
omission. Judgement lives in four capability seats filled by the host agent, with a
schema contract on each and a recorded fallback. The measured comparison (taken
before PR #3 strengthened the fallback) shows what the model seat buys: 6 multi-step
journeys vs 0, inputs filled vs never, 100 % checkable predicates vs 0 %.

**"Then why keep the deterministic path?"**
Three reasons: the demo never breaks; the fallback is the oracle the model output is
measured against; and it establishes the *floor* the model has to beat. PR #3 raised
that floor — the deterministic planner now produces 4 multi-step journeys and 71 %
predicate coverage on its own, with every assert value taken from text the crawler
actually saw. It still escalates on `checkable-assertions`, which is the honest
outcome: the missing 29 % are page texts the fetch-only crawl never reached, and no
amount of rule-following invents them.

**"How do I know the healing isn't just making tests pass?"**
Four rails plus an independent verifier. Expectations are byte-for-byte frozen and
asserted three times per heal; equivalence must be explicitly confirmed by the
sub-agent; exactly one retry; and a heal without before **and** after screenshots is
downgraded to `blocked`. Then `saveResult` re-checks all of it, and
`qa-agent audit <run-id>` re-checks it again from disk with different code.

**"What happens on an app you've never seen?"**
Honestly: a server-rendered app works well (11 flows, gate 0.95, PRD gap correctly
identified on the demo app). A client-rendered SPA currently degrades — one flow,
escalate — but it degrades *visibly*: the brief warns the planner, `degraded` is
recorded, and the report says so. The fix is a browser-based crawl and the adapter
already exists.

**"Why not just use Playwright codegen?"**
Codegen produces selectors, which are the thing that breaks. Here the semantic YAML
is the contract and selectors are rewritable state in a sidecar — which is exactly
what makes conservative healing possible without touching what the test asserts. The
generated `.spec.js` files are still emitted, as portable artifacts for the
developer's own runner.
