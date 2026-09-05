# 5-minute optimized-orchestration demo

This is a maintainer demo. Application developers use the installed
`$autonomous-qa` skill and do not run these commands themselves.

## Setup

Start the deterministic demo application in a separate terminal:

```bash
PORT=4555 npm --prefix demo-app run dev
```

Keep the existing `.qa/` workspace. History reuse is part of the product; do
not delete evidence to manufacture a cold run. Use `--no-history` when a forced
cold comparison is needed.

## 0:00 — one request, two execution modes

Run the cold path through the reference Playwright executor:

```bash
node scripts/run-with-playwright.mjs \
  --url http://127.0.0.1:4555 \
  --username demo --password demo \
  --prompt "focus on checkout and authentication" \
  --prd docs/prd.md \
  --no-history
```

Say: the cold path probes once, discovers same-depth routes concurrently,
partitions evidence by route ownership, gates the merged plan, generates
target-isolated artifacts, and executes specs through fresh browser contexts.

## 1:15 — repeat the exact request

Run the same command without `--no-history`:

```bash
node scripts/run-with-playwright.mjs \
  --url http://127.0.0.1:4555 \
  --username demo --password demo \
  --prompt "focus on checkout and authentication" \
  --prd docs/prd.md
```

Open the newest orchestration `trace.jsonl`. Point out:

- `memory:history_hit`;
- no crawl or planner fan-out events;
- no generation stage;
- `run:spec_completed` with Playwright execution; and
- a newly persisted report and verdict.

The repeat reuses the plan/spec/replay artifacts, not the previous result. It
still probes and executes the live application.

## 2:15 — context and parallelism

Open:

- [Current orchestration structure](current-orchestration-structure.md), sections
  3 and 4; and
- one cold `trace.jsonl` beside one exact-hit trace.

Explain the bounds:

- discovery: 4 by default, 8 maximum;
- route-owned planning: 3 maximum;
- isolated spec execution: 3 by default, 8 maximum; and
- fixtures/destructive flows: one shared application-state lock.

Workers receive compact route-owned evidence, not the full conversation, skill,
raw HTML, traces, secrets, prior plan, or verdict.

## 3:15 — artifact trust

Open a semantic YAML spec and its adjacent `.playwright.mjs` and
`.playwright.json` files. The YAML is authoritative. The manifest binds the
replay to the semantic source and script hashes; promotion requires three fresh
zero-retry passes. Exact checkpoint identities prevent duplicate assertions
from satisfying a simple count.

## 4:00 — evidence and limitations

Open `report.md`, `request.json`, and `trace.jsonl`. Then show
[Optimized agent orchestration](optimized-agent-orchestration.md):

- 30/30 exact-history and trusted-replay hits;
- 680.56 ms baseline repeat versus 195.08 ms optimized repeat;
- 1 ms median and 2 ms p95 exact-history lookup; and
- complete raw invocation JSON under `docs/benchmarks/`.

Say the limitations explicitly: discovery is still fetch/HTML based; similarity
is lexical; cross-process mutable-state locks and enforced capability deadlines
remain roadmap items; and the repository coverage threshold is still red.

## Optional adversarial checks

```bash
npm run demo:corners
npm run demo:corners -- --case P3
npm run demo:corners -- --case H7
npm run demo:corners -- --case E5
```

These test the planner, healing, design, and executor refusal contracts. They do
not replace the controlled timing benchmark:

```bash
npm run benchmark:orchestration -- --samples 30 --warmups 3
```
