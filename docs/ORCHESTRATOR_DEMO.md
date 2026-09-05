# 5-minute demo

## Setup
pkill -f demo-app/server.js          # remove stale 4555/4560 processes
PORT=4555 node demo-app/server.js &  # restart only 127.0.0.1:4555
rm -rf .qa                           # cold start, no pre-existing specs

Before presenting, open the latest `report.md`, `trace.jsonl`, and one
`generated/*.spec.js` containing `test.fixme`. These are fallback tabs if
Chromium stalls.

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

## 1:45 — preflight, then proof
Open generated/*.spec.js beside .qa/specs/*.yaml. The YAML has no
selectors. Fetch preflight can reject obvious locator or assertion misses, but
it cannot prove authenticated or post-action state. Browser replay is the proof;
unproved generated checks remain `test.fixme`.

## 2:30 — four beats, one unchanged contract
Reset and rerun the same semantic YAML in this order:

```bash
curl -X POST localhost:4555/__demo/reset -d 'scenario=pass'
curl -X POST localhost:4555/__demo/reset -d 'scenario=drift'
curl -X POST localhost:4555/__demo/reset -d 'scenario=functional'
curl -X POST localhost:4555/__demo/reset -d 'scenario=design'
```

Use the resets to show the four application surfaces, not to claim four distinct
harness verdicts. In the Sep 5 rehearsal, every beat completed at 3/7 clean with
four `app_defect` reds and exit 10. Because the pass variant has no injected shop
defect, its four reds are demonstrably harness false-reds. The aggregate output did
not distinguish pass, drift, functional, and design.

## 3:30 — it refuses to lie
The functional run remains red and produces no false green, but do not call its
four `app_defect` classifications shop bugs. The current fallback triage also uses
that label when the harness fails to prove a step. Say: “Four stayed red and there
were zero false greens; three or four reds are harness proof failures, not proof
that the shop is broken.” Exit 10 means the pipeline completed with a red verdict;
it is not a crash. The healer remains forbidden from changing an assertion.

## 4:15 — the report
report.md, PRD gap section: REQ-4 promo code, uncovered, no promo
input exists on /checkout. A product gap, not a test gap.

## 4:45 — trade-offs
Fetch-only crawler for portability. Fetch preflight, then browser replay.
Semantic YAML is canonical; generated JavaScript and locator sidecars are
disposable. Source hashes catch edits before trusted replay.

## Optional technical-Q&A drill (off clock)

Run the complete documented judgement matrix:

```bash
npm run demo:corners
```

Or let the reviewer select a single adversarial contract:

```bash
npm run demo:corners -- --case P3
npm run demo:corners -- --case H7
npm run demo:corners -- --case E5
```

`npm run demo:reset -- --list` shows the app-backed cases. In addition to the
headline `pass`, `drift`, `functional`, and `design` states, the live target now
has `missing-target` (H2), `fixture` (H4), `drift-functional` (H7), and
`cleanup` (E5). Plan against `/spa-shell` for the degraded client-rendered
crawl case (P7). The remaining cases stay explicit runtime probes rather than
being disguised as UI mutations.
