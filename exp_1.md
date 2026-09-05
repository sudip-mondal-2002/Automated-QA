# exp_1 — branch review notes (for teammates)

Branch `exp_1` vs `main`. Three commits on top of `main`:

- `4c7f514` feat(exp_1): channel-aware specs, governance audit, chat demo
- `781d2af` feat(exp_1): P0-P2 trace, planner crawl, coverage gate
- `9410bc1` P3-P7 done
- plus one uncommitted batch (honesty fixes + Playwright adapter + docs + README section — commit it before pushing).

## Test status (measured, not claimed)

- `node --test` → **147/147 pass**.
- `npm run test:coverage` → **97.43% lines / 85.76% branches / 93.50% funcs** — gates (100/95/98) are **RED**.
  Worst files: `generator.js` 54% branches, `reporter.js` 58%, `orchestrator.js` 68%,
  `playwright-executor.js` 68%, `planner.js` 73.5%, `coverage.js` 74%.
  Deliberate call: functionality first, coverage sweep explicitly cut before the final.
- Nothing is installed globally. `npm install` → local `node_modules/` only.
  `@playwright/test` is a **devDependency only**; the shipped skill bundle
  (`runtime/qa-agent.mjs`) contains zero adapter/runner references (verified by grep —
  the only "playwright" string is inside the generated-spec template).
  Browsers live in `~/Library/Caches/ms-playwright` (or set `PLAYWRIGHT_BROWSERS_PATH`).

## What was built

**1. Channel-aware semantic specs (`4c7f514`)**
Optional `channel: web|chat|voice|workflow|api` on spec/fixture/result steps
(schemas + `draft.js` inference + `--channel` on `create` + `channelFor()` in
execution + `RESULT_CHANNEL_CHANGED` guard in storage). Missing = `web`, so old
specs still validate. Motivated by Aivar (voice/conversational + agentic
workflows, not just web clicks).

**2. Governance audit (`4c7f514`)**
`qa-agent audit <run-id>` prints a PASS/FAIL checklist: classification known,
expectations/channels byte-for-byte unchanged, healing before/after evidence,
design findings + actual screenshot, screenshot declarations, no secret leak.
This is the "governed AI" story for enterprise judges.

**3. Demo chat surface (`4c7f514`)**
`demo-app` `/chat` endpoint + `chatAnswered` state, conversational/workflow
sample specs, executor support. `DEMO_SCENARIOS` now has 5 entries
(pass/drift/functional/design/**locator**).

**4. Orchestrator pipeline P0–P2 (`781d2af` + hardening)**
`src/trace.js` (JSONL tracer with redaction + degraded mode),
`src/planner.js` (fetch-only BFS crawl, cookie auth-first, flow synthesis:
happy/error-per-form/login-negatives/list-numeric-payment edges, prompt
aliases, PRD block parsing), `src/coverage.js` (10 rules, skipped-rule
semantics excluded from numerator AND denominator, `decideVerdict` with
`prevScore` oscillation guard → escalate on non-improvement).
`test-support/fake-fetch.js` harness + recorded fixtures in
`test-support/fixtures/` (P3 generator tests read fixtures, never re-crawl).

**5. Orchestrator pipeline P3–P7 (`9410bc1`)**
`src/locator-chain.js` (testid→role→label→text→css fallback + triage table:
broken_locator 0.9 / app_defect 0.85–0.7 / flaky 0.8 / environment 0.95,
expectation-guard trips → app_defect 1.0, never healed),
`src/generator.js` (semantic YAML stays source of truth; emits
`generated/*.spec.js` + `*.locators.json` sidecar + `_resolve.js`, live
selector validation stamp), `src/reporter.js` (`report.json/md`, PRD-gap,
untested-risk), `src/orchestrator.js`
(`qa-agent orchestrate --url …`, EXIT codes 0/10/11/12/20/30/40),
UI route `GET /api/orchestrations/:id/trace?since=`, demo `locator-drift`
variant + `data-testid`s + empty-card 400 validation.

**6. Honesty-fix batch (uncommitted — review carefully)**
An adversarial review (scored us 46/100) found the pipeline finished but
tested nothing. Fixed for real, no threshold tuning:
- Gate 0.53-escalate → **0.95-pass**: planner under-production bugs
  (1-expect flows, zero edge flows, prompt/gate alias mismatch, input-less
  forms, PRD title stealing REQ-1, generic-keyword false coverage).
- Report join bug: runs now attach via `flowMap`, `specFile` paths match
  emitted files, shell-mode runs report `blocked` with reasons (was fake `skipped`).
- Planner intents use the form's submit label ("Place order", not
  "Submit form on /checkout"); auth-gate pages titled honestly.
- `docs/prd.md` (REQ-4 promo has no matching input — deliberate product-gap
  demo), `docs/ORCHESTRATOR_DEMO.md`, `docs/architecture.md` (as-implemented),
  README orchestrate section.
- `src/playwright-executor.js`: real-browser adapter (form fill from fixture
  inputs, link-preferring nav, negation-aware observe, per-step input
  clearing for isolation). Takes an injected `page`; no static Playwright import.
- `scripts/run-with-playwright.mjs`: dev-only runner (outside the bundle).

## What was proven live (evidence, not intent)

- Cold `orchestrate` on demo-app: gate **pass at 0.95**, 11 flows (5H/4E/2e),
  10/10 selectors validated, full `trace.jsonl` (30 events), PRD gap **0.8
  with exactly REQ-4 uncovered**.
- Real Chromium run (`scripts/run-with-playwright.mjs`): browser opens,
  **5/11 scenarios genuinely pass** (login journey, both view smokes,
  double-submit guard, unauth-redirect), exit 10 `defects_found`.
- Shell mode stays `blocked` with reasons (exit 11 `incomplete`) — by design.
- Adversarial inputs behave: dead port → `ORCHESTRATION_TARGET_UNREACHABLE`,
  remote w/o flag → `ORCHESTRATION_REMOTE_BLOCKED`, bad PRD → clear error.

## Known gaps (do not claim these work)

1. 6/11 live failures are real capability gaps, not lies: negative-then-submit
   flows need the submit-label fallback (in newest uncommitted code, unverified
   live), `unauth-redirect` needs session isolation (single page reused — needs
   per-spec browser contexts, not implemented).
2. Replan loop is unit-tested but never observed live (gate passes attempt 1
   on the demo app). The "gate finds gaps → replans → passes" demo beat needs
   a sparser target or a seeded gap.
3. Triage `broken_locator→healed` and `app_defect→exit 10` on
   locator-drift/broken variants not yet demonstrated live (adapter landed after).
4. Coverage gates RED (see numbers above). No judge runs them, but don't claim green.
5. Journey-step upgrade (cookie sessions in demo-app + BFS open-steps in
   planner) was started and **paused mid-work** — single-step flows assume a
   start page the executor can't always infer. See "Next" below.

## Next (priority order)

1. **Live-verify the uncommitted batch**: reset demo to `pass`, run the Playwright
   runner, confirm 9–10/11 (only `unauth-redirect` expected red). Then
   `locator-drift` → expect `broken_locator/healed` + sidecar promotion;
   `broken` → `app_defect`, no heal, exit 10.
2. Decide `unauth-redirect`: per-spec browser contexts in the runner script
   (dev-only, ~30 lines) or cut the flow and say why on stage.
3. Replan demo: run against a target/scenario where the gate genuinely replans
   (e.g. temporarily hide a page), or present the pass + unit-tested replan honestly.
4. Coverage sweep only if time remains (generator/reporter/orchestrator branches).
5. Logistics: commit, merge `exp_1` → main (or make default), push, make public,
   clone-test into /tmp from scratch, `npx playwright install chromium` on demo
   machine, verify fully offline on 127.0.0.1, tag a rollback commit, terminal font 16–18pt.
6. Explicitly cut: branch-coverage sweep as a gate, `--concurrency`, `src/llm.js`
   ("deterministic by design" is the better stage answer).

## Review commands

```bash
git diff main --stat
node --test                       # expect 147/147
npm run build:skill               # rebuilds skill runtime + copies schemas
node demo-app/server.js --port 4555 &
node scripts/run-with-playwright.mjs --url http://127.0.0.1:4555 \
  --username demo --password demo --prompt "focus on checkout and authentication" \
  --prd docs/prd.md --root /tmp/qa-live
```

Suggested commit message for the pending batch:

```
feat(exp_1): honest gate pass, report join fix, playwright adapter, docs

Gate 0.53 escalate -> 0.95 pass via planner fixes, not thresholds.
147/147 tests pass. Shell-mode stays blocked with reasons.
Gates RED (97.4/85.8/93.5) — sweep cut before final.
```
