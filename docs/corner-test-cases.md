# Corner test cases — sub-agents (planner, healing, design, executor)

Scope: judgement capabilities the skill supplies as sub-agents. Runtime rails
(`crawl`, `gate`, `generator`, `trace`) are out of scope except where they
validate a sub-agent draft. See `.agents/skills/autonomous-qa/SKILL.md`
Planner sub-agent + Safety invariants, `src/planner-agent.js`,
`src/healing.js`, `src/execution.js`, `src/native-executor.js`.

Live check: `demo-app` (`npm run dev`, default `http://127.0.0.1:3000`)
via the skill bundle per `README.md`:

```bash
node .agents/skills/autonomous-qa/scripts/qa-agent.mjs orchestrate \
  --url http://127.0.0.1:3000 --root "$PWD" --plan-only
# shell without native executor => blocked is correct, plan/gate still verified
```

Unit mirror: `test/subagents-corner.test.js` (`node --test test/subagents-corner.test.js`).

## Demo integration

The five-minute demo keeps its four-beat story, while a separate executable
drill makes this entire matrix available during technical Q&A:

```bash
npm run demo:corners                    # verify all 28 documented contracts
npm run demo:corners -- --case H7       # verify and explain one selected case
npm run demo:corners -- --list          # print the matrix without running tests
npm run demo:reset -- --list            # list the live app mutations
```

`demo:corners` reads the IDs and wording from this document, runs the exact
focused evidence tests mapped to each ID, and fails if the document and evidence
map drift apart. It distinguishes executable contract evidence from live app
mutations instead of pretending every capability-boundary case is a browser
state.

The app now exposes these deterministic live states without changing the
semantic checkout spec:

| Reset scenario | Corner | Expected result |
| --- | --- | --- |
| `pass` | D1 | functional `passed`; no undeclared design verdict |
| `drift` | H1 | `healed` after one equivalent retry |
| `missing-target` | H2 | `functional_regression`; no equivalent action exists |
| `functional` | H3 | `functional_regression`; changed outcome is never re-asserted |
| `fixture` | H4 | failed login postcondition → `functional_regression` |
| `drift-functional` | H7 | earlier heal succeeds, later failure wins |
| `design` | D4 | reference-backed `design_regression` with function intact |
| `cleanup` | E5 | primary `passed` result retained, cleanup issue recorded |

For P7, start the demo app and plan against
`http://127.0.0.1:3000/spa-shell`; the HTTP source is only a client-rendered
shell, so a fetch-only crawl must report degradation rather than full coverage.

## P — Planner sub-agent (`planWithAgent`, `reviewDraft`, brief)

| ID | Corner | Input | Expected |
| --- | --- | --- | --- |
| P1 | No capability | `planner` undefined | deterministic fallback, `plan.source.fallbackReason=/no planner capability/`, run continues |
| P2 | Capability throws | `planner` rejects `sub-agent unavailable` | fallback + reason recorded, `planner_failed` traced, no stall |
| P3 | Invalid draft x2 | kind `nope`, or `selector:#pay` extra key | 2 attempts, 2nd `feedback=/rejected/`, then `fallbackReason=/rejected after 2/`, usable plan |
| P4 | Empty flows | `{flows:[]}` | `reviewDraft.ok=false`, never generates from empty plan |
| P5 | Prose copied to assert | `assert.value="Order confirmation is visible"` | rejected by instruction or refuted at `validateSelectors`; honest path is omit predicate -> `UNVERIFIED` |
| P6 | Anonymous crawl + `authenticated` flow | `auth:{authenticated:false}` | brief says `CRAWL SESSION: anonymous`, first step signs in or `openQuestions` records doubt |
| P7 | Degraded SPA shell | `<div id=root>` only, `degraded:true` | brief `WARNING: crawl looks degraded`, plan does not claim full coverage |
| P8 | Truncated sitemap | `maxChars:40` | ends `site map truncated`, planner says so in `openQuestions` |
| P9 | ID collision | two flows slug to `flow_checkout` | `normalizePlan` dedupes (`flow_checkout-2`), both addressable |
| P10 | Lifecycle legibility | any run | `trace.jsonl` has `planner_started` + `planner_completed`/`planner_rejected`/`planner_failed` |

## H — Healing / rediscovery (`normalizeRediscovery`, `classifyFailure`, `createExpectationGuard`)

| ID | Corner | Input | Expected |
| --- | --- | --- | --- |
| H1 | Rename, behavior intact | `rediscovery:{status:found,equivalent:true,target}` | `retry_equivalent_target`, one retry, `healed` only if original expectations pass unchanged + before/after evidence |
| H2 | Button removed | `equivalent:false` / no target | `functional_regression`, `No safe equivalent target` |
| H3 | Copy/outcome changed | expectation text differs | never heal; `functional_regression` (guard: model may re-locate, never re-assert) |
| H4 | Fixture postcondition fails | `before/between/after` postcondition | never heal, `functional_regression` — **implemented**: `src/execution.js` maps a `failed` `before`/`between` fixture to `functional_regression` and only a genuinely `blocked` one to `blocked`; covered by `test/execution-boundaries.test.js` ("H4: failed fixture postconditions are functional regressions, never blocked or healed") |
| H5 | No capability | `supports(rediscover)=false` => `rediscovery:null` | no retry, stays `failed/blocked` with reason |
| H6 | Native blocked/ambiguous | `{status:blocked}` or garbage | `classifyFailure` -> blocked/failed, uncertainty never pass |
| H7 | Later failure overrides heal | heal succeeded then later step fails | final `functional_regression` |
| H8 | Expectation-stage failure without `waitFor` | `supports(waitFor)=false` | no wait, stays failed; with `waitFor` only on observable readiness, never fixed sleep |

## D — Design comparator (`normalizeDesignComparison`, `resolveDesignReference`)

| ID | Corner | Input | Expected |
| --- | --- | --- | --- |
| D1 | No explicit reference | spec has no `design` | `not_checked`, taste never creates `design_regression` |
| D2 | Missing evidence | declared check but no actual/ref screenshot | `blocked`, never inferred pass |
| D3 | Invalid comparator output | garbage status | `ambiguous/blocked` with explanation |
| D4 | Function passes, ref+actual support findings | layout/order/grouping/style diffs | `design_regression` with structured findings + provenance; functionality verdict untouched |

## E — Native executor / safety (`detectNativeCapability`, `NativeExecutor`, secrets)

| ID | Corner | Input | Expected |
| --- | --- | --- | --- |
| E1 | Kind mismatch | `web` env + `desktop` driver | `available:false`, `Environment requires a native web executor…` |
| E2 | Missing methods | driver lacks `act/observe/screenshot` | `available:false` naming missing methods |
| E3 | No executor (shell-only `run`) | `executor` undefined | `blocked` with `No native Browser or Chrome capability was provided`, never claim UI drive |
| E4 | Secret leak | `${QA_CUSTOMER_PASSWORD}` resolved | never in YAML, result, trace, terminal, screenshot |
| E5 | `after` cleanup fails | `after` fixture throws | finally-path still attempted, primary classification preserved |
| E6 | Remote target without flag | `https://example.com` | `ORCHESTRATION_REMOTE_BLOCKED` unless `--allow-remote`; loopback-only UI |

## Live verification against `demo-app` (skill bundle, no browser)

1. `cd demo-app && PORT=4555 node server.js &` (or `npm run dev`), `curl http://127.0.0.1:4555/` 200.
2. `node .agents/skills/autonomous-qa/scripts/qa-agent.mjs orchestrate --url http://127.0.0.1:4555 --username <u> --password <p> --root "$PWD" --plan-only` — expect `test-plan.json`, `gaps.json`, `report.json` under `.qa/runs/orchestrations/<id>/`, `Planner: deterministic` line. Shell run without executor reporting `blocked` on full `orchestrate` (no `--plan-only`) is correct per README honest notes.
3. Repeat with `--plan <draft.json>` (valid Planner draft) then with broken draft x2 to observe P2/P3 fallback reason in `report.planSource`.
4. Run `npm run reset -- --list` in `demo-app`, choose a documented mutation, and re-run. Shell mode stays `blocked` (no native capability); full pass/heal/regression needs a host native executor or `scripts/run-with-playwright.mjs`.

## Live verification with a real Chromium executor (2026-09-05)

Ran the demo app (`PORT=4555`, all four `/__demo/reset` scenarios) against two real native-capability paths instead of shell-only mode, using `--username`/`--password` flags for the login fixture credentials:

- `scripts/run-with-playwright.mjs` (real Playwright Chromium, the repo's dev-only reference driver).
- The agent itself driving the Browser pane (real Chromium) end to end, acting as the native-execution + judgement sub-agent the skill is designed around.

**Bug found and fixed in the Playwright reference driver**: `src/playwright-executor.js`'s "single visible submit button" fallback fired on the `login-customer` fixture's `Open the login page` step (a pure observation step — no click is required since the fixture is already there), clicking "Sign in" with empty fields a step early. Fixed by excluding `open|view|go to`-shaped intents from that fallback (`src/playwright-executor.js:64-69`); `test/playwright-executor.test.js` still passes. Out of scope for the shipped skill runtime (this driver is explicitly dev/demo-only), but it was blocking live verification of native execution.

**Agent-driven Chromium run, all four scenarios, `checkout-card`/`checkout-design` specs:**

| Scenario | Observed | Classification given | Corner ID |
| --- | --- | --- | --- |
| `stable` | Full login → cart → checkout → confirm → cleanup | `passed` | — |
| `drift` | "Proceed to checkout" replaced by collapsed `Checkout options` → `Continue to payment` (same `href=/checkout`) | `healed` — explicit equivalent target, one retry, original expectation verified unchanged | H1 |
| `functional` | Checkout submits but confirmation shows "Order could not be completed" | `functional_regression` — correctly refused to rewrite or re-assert a business outcome | H3 |
| `design` | Functionally identical to the approved reference (confirmation text present, no error) but link/heading order reversed and restyled as a red banner | `design_regression` with structured order/grouping/style findings, functional verdict untouched | D4 |

This confirms the skill's judgement contract holds under real interaction: an agent driving a real browser correctly separates "interaction drifted, outcome unchanged" (heal) from "the outcome itself broke" (never heal), and treats layout/style regression as orthogonal to functional correctness.

## Known gaps (as of 2026-09-05)

- **H4 is now implemented** (was: fixture postcondition failures collapsed into `blocked`). `src/execution.js` distinguishes a fixture that returned `"failed"` — a real postcondition assertion failure, now reported as `functional_regression` and never healed — from one that returned `"blocked"`. `test/execution-boundaries.test.js` exercises both `before` and `between`; the `fixture` demo mutation exercises the `before` path end to end with the deterministic native executor.
- H7, H8, D4, and E5 remain distributed across the broader execution/healing/design suites rather than duplicated in `test/subagents-corner.test.js`; `npm run demo:corners` resolves that distribution into one selectable drill.
- D1 now has an end-to-end deterministic demo assertion: the unchanged checkout passes with no `design` result when no reference was declared. E4 intentionally combines execution-persistence, inspection, and trace-redaction evidence; screenshots are captured only with `avoidSensitiveFields: true`.
