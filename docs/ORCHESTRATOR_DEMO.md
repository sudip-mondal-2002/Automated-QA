# 5-minute demo

## Setup
node demo-app/server.js &            # 127.0.0.1:4555
rm -rf .qa                           # cold start, no pre-existing specs

## 0:00 — one input
qa-agent orchestrate --url http://127.0.0.1:4555 \
  --username demo --password demo \
  --prompt "focus on checkout and authentication" \
  --prd docs/prd.md

Say: the URL is the only required input. Credentials and prompt
are optional enrichment.

## 0:45 — the gate decides
Open test-plan.md, then gaps.json. Gate scores the plan, finds
fixable gaps, replans, re-scores, passes. Point at trace.jsonl.
No human in that loop.

## 1:45 — validation
Open generated/*.spec.js beside .qa/specs/*.yaml. The YAML has no
selectors. The .spec.js carries validated:true and the strategy
counts. Every button was confirmed against the live page before
the file was written.

## 2:30 — it adapts without failing
curl -X POST localhost:4555/__demo/reset -d 'scenario=locator'
Re-run. The suite stays green: renamed controls still resolve and every
fuzzy resolution leaves a receipt (`fuzzy 1/2`) in the selected target.
Re-run again on `pass`: identical greens. Then show the contrast:

## 3:30 — it refuses to lie
curl -X POST localhost:4555/__demo/reset -d 'scenario=functional'
Re-run. Same pipeline, different verdict: the two confirmation-dependent
flows go `app_defect`, nothing heals, exit 10. The healer is
architecturally forbidden from touching an assertion. (A live `healed`
recovery is unit-proven in test/healing.test.js; the semantic healer fires
on action-stage failures with before/after evidence. Full cross-run sidecar
promotion is scoped roadmap, not claimed.)

## 4:15 — the report
report.md, PRD gap section: REQ-4 promo code, uncovered, no promo
input exists on /checkout. A product gap, not a test gap.

## 4:45 — trade-offs
Fetch-only crawler for portability. Playwright files as portable
artifacts. Semantic YAML as the contract, selectors as rewritable
state.
