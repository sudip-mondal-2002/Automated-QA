# Corner Cases Evaluation — What We Fixed and How We Know

This document records the run of all 28 corner cases for the autonomous QA
skill. In plain English: we poked the system with 28 tricky edge cases where it
could have silently broken, hidden a problem, or faked a success — and in every
single one it did the right, honest thing.

A corner case is a "what if" that tries to break the system's good behavior.
The fix is the rule or mechanism the system uses to stay honest when that "what
if" happens. Each section below explains what broke, what the system did, and
how you can verify it.

---

## The 28 corner cases at a glance

| ID | What was thrown at it | What the system did | How to verify it worked |
| --- | --- | --- | --- |
| P1 | No AI planner provided | Used a built-in safe plan | Check plan source says "deterministic" |
| P2 | The AI planner crashed | Caught it, used safe plan | Check fallback reason recorded |
| P3 | AI gave a bad plan twice | Rejected it, used safe plan | Check "rejected after 2" reason |
| P4 | AI gave an empty plan | Refused to use it | Check plan was rejected |
| P5 | AI smuggled CSS selectors | Rejected the plan | Check validation failed |
| P6 | Anonymous crawl + auth pages | Warned the planner | Check brief says "anonymous" |
| P7 | Bare client-rendered page | Flagged it degraded | Check WARNING in brief |
| P8 | Sitemap too big | Truncated + said so | Check "site map truncated" |
| P9 | Two flows same name | Renamed second one | Check unique IDs |
| P10 | Lifecycle events | Logged every step | Check trace.jsonl |
| H1 | Button moved + renamed | One retry, healed | Check "healed" + evidence |
| H2 | Button removed | Honest failure | Check functional_regression |
| H3 | Outcome text changed | Never healed it | Check functional_regression |
| H4 | Login fixture postcondition failed | Real regression, not blocked | Check functional_regression |
| H5 | No rediscovery ability | No retry, honest failure | Check stays failed |
| H6 | Ambiguous/broken rediscovery | Never becomes a pass | Check blocked/failed |
| H7 | Heal then break later | Later failure wins | Check final functional_regression |
| H8 | Slow-to-appear outcome | Waited only on real readiness | Check healed or honest failure |
| D1 | No design reference | No design verdict | Check design not_checked |
| D2 | Design check but no screenshot | Blocked, never inferred | Check blocked |
| D3 | Comparator gave garbage | Blocked with explanation | Check blocked |
| D4 | Layout changed but function fine | Design regression with proof | Check design_regression |
| E1 | Web app + desktop driver | Refused to run | Check available:false |
| E2 | Driver missing methods | Refused to run | Check missing methods named |
| E3 | No browser at all (shell) | Blocked with reason | Check "No native ... capability" |
| E4 | Password in a variable | Redacted everywhere | Check [REDACTED] in output |
| E5 | Cleanup failed after pass | Kept pass, noted cleanup | Check passed + cleanup issue |
| E6 | Remote target without flag | Blocked | Check ORCHESTRATION_REMOTE_BLOCKED |

---

## What actually happened in this run

Commands run against the live demo app (ports 3000 and 4555), which is a small
fake shop app that can be reset into each broken state on demand.

| Check | Result | Time |
| --- | --- | --- |
| All 28 corner-case evidence tests | **28/28 passed** | ~4.4s |
| Live scenario test (D1, H1, H2, H3, H4, H7, E5) | **passed** | ~0.5s |
| Real Chromium orchestration (browser actually clicked through) | **3/7 clean, 4 failed as expected** | ~30s |
| Live app reset to every state | **all 9 scenarios reset OK** | instant |
| Design + reset regression suites | **15/15 passed** | ~1.8s |

The four "failed" scenarios in the real-browser run are **not** bugs — they are
the broken states we deliberately created, and the system correctly reported
them as real failures instead of hiding them.

---

## How the "fix" works, explained simply

The system has four areas. Each one has a simple rule that stops it from
cheating.

### Planner — making the test plan (P1–P10)

The planner turns a website into a list of things to test. The tricky part: the
AI that writes the plan might be missing, crash, or write nonsense.

The fix is a **safe fallback**:

- If the AI is missing or crashes (P1, P2), the system builds a safe plan
  itself using a built-in rule-based planner. It records *why* it did this.
- If the AI's plan is bad (P3, P4) or sneaks in CSS selectors (P5), the plan is
  rejected — the system never runs a plan that doesn't match its rules.
- If the website gave almost no info (P7, P8), the system says so instead of
  pretending it covered everything.
- Every decision is logged (P10) so you can see exactly what happened.

**How you'd measure it:** the plan's `source` field says `deterministic` with a
fallback reason instead of `planner`, and the trace log shows a rejected/failed
event. No silent stall, no invented coverage.

### Healing — when buttons move or break (H1–H8)

The app changes over time. A "Proceed to checkout" button might get renamed or
moved. Healing tries to recover. The tricky part: it must never change what the
test is actually checking.

The fix is a **one-retry, evidence-backed rule**:

- If a button moved but still leads to the same place (H1), the system retries
  **once** on the equivalent target, proves the original expectations still
  pass, and saves before/after proof. Result: `healed`.
- If the button is gone (H2) or the outcome text actually changed (H3), it
  **never** heals — that's a real `functional_regression`.
- A failing login/postcondition (H4) is a real product problem, not a flaky
  environment issue, so it's a regression, never healed or hidden.
- If a later step breaks after an earlier heal (H7), the later failure wins.
- If there's no way to rediscover (H5, H6), the system stays honestly failed.

**How you'd measure it:** the result shows `healed` only with before/after
screenshots and the *unchanged* expectation list. Anything that can't be proven
equivalent stays `failed` or `blocked`. Uncertainty never becomes a pass.

### Design — comparing the look (D1–D4)

The app might still work but look wrong. The tricky part: design judgment is
subjective, so the system must never call something a regression just because
it "doesn't like" it.

The fix is **reference-backed comparison**:

- No design reference declared (D1)? No design verdict at all.
- Design check declared but no screenshot captured (D2), or the comparator gave
  garbage (D3)? `blocked` — never an inferred pass or fail.
- The layout changed and there's a real reference plus a screenshot (D4)?
  `design_regression`, with concrete findings (order, grouping, style), while
  the functional verdict stays untouched.

**How you'd measure it:** a `design_regression` only ever appears when there is
an explicit approved reference, an actual screenshot, and a concrete finding to
point at. No reference = no design opinion.

### Executor — the browser and secrets (E1–E6)

This area handles whether a real browser is available and whether secrets stay
secret. The tricky part: a missing browser must not be faked, and passwords
must never leak.

The fix is **honest capability detection and redaction**:

- Wrong kind of driver (E1) or missing driver methods (E2)? Refused to run,
  with the reason.
- No browser at all (E3)? `blocked` with "No native Browser or Chrome
  capability was provided" — it never claims it drove a UI when it didn't.
- A password variable (E4)? Replaced with `[REDACTED]` everywhere: results,
  trace, terminal, screenshots.
- Cleanup failed after a successful run (E5)? The pass is kept and the cleanup
  problem is recorded separately — cleanup never hides a good result, and never
  turns a good result bad.
- A remote website with no flag (E6)? Blocked. It only ever tests local sites
  unless you explicitly allow it.

**How you'd measure it:** the result says `blocked` with a clear reason instead
of pretending; and searching the output for the password value returns only
`[REDACTED]`.

---

## The one idea behind all 28 fixes

Every corner case comes down to a single principle:

> **The system never guesses, and it never changes what it's checking.**

Concretely that means four promises the tests prove:

1. **Honest degradation** — if something can't work, it says so and falls back
   to something it *can* do. It never fakes.
2. **Unchanged expectations** — when the UI moves, the test still checks the
   *same* thing. It never rewrites the goal to make itself pass.
3. **Evidence-backed decisions** — healing and design verdicts always need
   proof (before/after shots, an approved reference, a concrete finding).
4. **Secret redaction** — passwords and keys never appear in anything saved or
   shown.

If you change a state with `npm run demo:reset` and the system comes back
"passed" when the state was supposed to break — that is the system cheating.
The whole point of these 28 tests is that it never does.

---

## How to verify or re-run it yourself

```bash
# Run all 28 corner-case contracts (green = good)
npm run demo:corners

# Verify just one case and see its contract
npm run demo:corners -- --case H7

# Print the matrix without running tests
npm run demo:corners -- --list

# Reset the demo app into a broken state (the "what if")
npm run demo:reset -- drift
npm run demo:reset -- missing-target
npm run demo:reset -- functional
npm run demo:reset -- fixture
npm run demo:reset -- drift-functional
npm run demo:reset -- design
npm run demo:reset -- cleanup

# Run the focused live scenario test end to end
node --test test/demo-corner-scenarios.test.js
```

## File map — where each fix lives

| Corner | Primary code | Primary tests |
| --- | --- | --- |
| P1–P10 | `src/planner-agent.js`, `src/planner.js` | `test/subagents-corner.test.js` |
| H1–H3, H5–H8 | `src/healing.js`, `src/execution.js` | `test/healing.test.js` |
| H4 | `src/execution.js` | `test/execution-boundaries.test.js` |
| D1–D4 | `src/design.js`, `src/execution.js` | `test/design.test.js` |
| E1–E3, E6 | `src/native-executor.js`, `src/orchestrator.js` | `test/subagents-corner.test.js` |
| E4 | `src/references.js`, `src/execution.js` | `test/execution-boundaries.test.js`, `test/trace.test.js` |
| E5 | `src/execution.js` | `test/execution.test.js` |
| D1, H1–H4, H7, E5 (live) | `demo-app/server.js` | `test/demo-corner-scenarios.test.js` |