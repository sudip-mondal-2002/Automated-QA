# 04 — Current orchestration pipeline, stage by stage

`qa-agent orchestrate --url <url>` is memory-first. The historical eight-stage
serial description is no longer accurate; this page follows the current source.

## Stage 0 — Admission and fingerprint

The runtime:

- admits only HTTP(S), with remote targets requiring `--allow-remote`;
- creates `orch_<epoch>_<random-suffix>` and an always-persisted redacting tracer;
- hashes the current application revision, including Git HEAD, staged/unstaged
  binary diffs, status, and non-ignored untracked contents outside `.qa/`; and
- creates a request fingerprint from target, normalized objective, PRD, planner
  mode, crawl limits, auth scope, revision, and contract versions.

Failure to resolve a revision returns a unique `unresolved:<uuid>` identity. It
cannot accidentally equal another unresolved state.

## Stage 1 — Memory

`resolveHistory()` searches before discovery.

- **Exact:** validate and load the prior plan, gaps, spec IDs, sitemap, and replay
  statuses. Later stages skip crawl, planning, gate reconstruction, and generation.
- **Similar:** retain same-origin scored specs as non-executable hints inside
  orchestration. The skill-level `history query` may recommend a strong,
  source-matched trusted replay with a prior clean result for direct execution.
- **Miss:** continue through the cold path.

The trace records the fingerprint, lookup duration, source orchestration on an
exact hit, and replay states. Raw historical traces and screenshots are never
placed into a planner prompt.

## Stage 2 — Live readiness

The exact requested URL—not merely its origin—is fetched with manual redirect
handling. Throws and 5xx responses map to `ORCHESTRATION_TARGET_UNREACHABLE`.

On a cold path, the successful response and body become the first crawl item.
This removes the duplicate readiness/crawl request and avoids observing two
different entry states.

## Stage 3 — Concurrent discovery

`crawl()` performs authenticated breadth-first discovery with defaults of 25
pages, depth 3, and concurrency 4 (maximum 8).

For each depth:

1. dequeue a bounded batch in stable order;
2. fetch the batch concurrently with the same established cookie snapshot;
3. restore response order;
4. parse normalized titles, headings, links, forms, fields, buttons, and signals;
5. enqueue valid same-origin, non-binary paths in stable order.

An entry login form can establish authentication before sibling discovery.
Successful pre-authentication is retained rather than overwritten. Fetch errors
are tolerated per page; sparse client-rendered shells are marked degraded.

## Stage 4 — Parallel planning

With a host planner capability, `planWithParallelAgents()`:

1. groups evidence by route ownership;
2. assigns each supported PRD clause to one best owner;
3. builds up to three compact immutable packets;
4. invokes them concurrently;
5. schema-validates each result and allows one bounded repair;
6. falls back per failed partition when needed; and
7. merges and deduplicates in stable order.

Without a capability, `buildTestPlan()` provides the deterministic fallback.
Every resulting plan records whether judgement or fallback produced it.

## Stage 5 — Independent gate

`coverage.js` evaluates the merged plan without worker identity or prior scores.
Six blocking and six advisory rules check form behavior, authentication
negatives, observable assertions, prompt scope, journey depth, edge boundaries,
orphan pages, destructive guards, and PRD coverage.

Blocking gaps must be actionable. Fixable gaps may be supplemented and rescored
within the replan bound; an unfixable gap or non-improving retry escalates. An
escalation writes a report and stops before generation/execution. `--plan-only`
also stops here with `UNVALIDATED`.

## Stage 6 — Idempotent generation

Each accepted flow becomes a target-prefixed selector-free semantic spec.
Mechanical action/page/input/predicate details are retained in the generated
locator sidecar and portable `.spec.js` output.

Preflight uses an explicit `probeLocator` capability when available or
conservative fetch evidence. It never calls an unconnected generic observation
method and never treats static absence as browser proof.

The adjacent import-free replay is content-addressed. If the semantic source
still matches an existing trusted replay, generation preserves that script and
manifest instead of downgrading it to a candidate.

## Stage 7 — Resource-locked execution

The runtime loads exactly the generated or history-selected spec IDs. Effective
concurrency is calculated as follows:

```text
fresh executor factory available                 → requested concurrency, max 8
all replays trusted and no shared native fallback → requested concurrency, max 8
otherwise                                         → 1
```

Fixtures and destructive/mutating intents share one application-state lock.
Other specs receive distinct resources. A resource waiter does not consume the
global semaphore, and result order remains the original spec order.

For each spec, `executeWithReplay()`:

1. verifies semantic source and replay script hashes;
2. executes a trusted replay once in a fresh browser;
3. verifies the exact expected `(step, expectation)` checkpoint set;
4. returns immediately on a complete browser pass; or
5. records the failed/unavailable/hybrid attempt and creates one native fallback
   lazily, preferring the isolated executor factory over a shared executor.

Previous target history is fetched only after action failure and only for the
same spec, environment, and step. Healing remains one equivalent-target retry.

Each concurrent result is saved with pointer selection disabled. Once all
workers join, the coordinator atomically selects the deterministic final run,
eliminating `.qa/last-test.json` races.

## Stage 8 — Report and close

`buildReport()` combines the frozen plan, gap history, generation metadata,
ordered execution rows, healing receipts, cache decision, and artifact paths.
The report is schema-validated before write. `trace.jsonl` includes per-stage
and per-spec durations, and the tracer closes in `finally` on every return path.

Exit meanings remain:

| Code | Meaning |
|---:|---|
| 0 | clean |
| 10 | defects found |
| 11 | escalated or incomplete |
| 12 | plan-only or generation unvalidated |
| 20 | unreachable/auth failure |
| 30 | usage error |
| 40 | internal contract error |

## Artifacts

Cold and exact paths both write a new orchestration directory. An exact hit
contains `generated/reused.json` pointing to its source artifacts rather than
regenerating them.

```text
.qa/runs/orchestrations/<orchestration-id>/
  request.json
  site-map.json
  test-plan.json
  test-plan.md
  gaps.json
  gaps.md
  trace.jsonl
  report.json
  report.md
  report.yaml
  generated/
```

See [Current orchestration structure](../current-orchestration-structure.md)
for the complete `.qa/` tree and exact context contracts, and
[Optimized agent orchestration](../optimized-agent-orchestration.md) for measured
performance and the before/after audit.
