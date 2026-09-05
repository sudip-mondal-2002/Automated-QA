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

## 2:30 — it repairs itself
curl -X POST localhost:4555/__demo/reset -d '{"variant":"locator-drift"}'
Re-run. Healer walks the chain, finds the button by role, promotes
it in the sidecar. Re-run again: passes first try.

## 3:30 — it refuses to lie
curl -X POST localhost:4555/__demo/reset -d '{"variant":"broken"}'
Re-run. Same failure signature, different verdict: app_defect,
no heal attempted, exit 10. The healer is architecturally
forbidden from touching an assertion.

## 4:15 — the report
report.md, PRD gap section: REQ-4 promo code, uncovered, no promo
input exists on /checkout. A product gap, not a test gap.

## 4:45 — trade-offs
Fetch-only crawler for portability. Playwright files as portable
artifacts. Semantic YAML as the contract, selectors as rewritable
state.
