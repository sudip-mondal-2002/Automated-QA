# 10 — Current gaps and roadmap

This list is current for the optimized memory-first orchestration. Earlier
versions of this page listed missing history, per-spec browser isolation,
target-specific namespaces, sub-agent envelopes, and parallel execution; those
items are now implemented and tested.

## Closed by the orchestration optimization

| Former gap | Current implementation |
|---|---|
| Every repeat reran the cold workflow | Exact request history and same-origin semantic replay search. |
| Serial fetch crawl | Bounded same-depth concurrent BFS with deterministic ordering. |
| One broad planner call | Up to three route-owned compact planner packets in parallel. |
| No worker governance | Immutable task/parent/deadline/input-hash envelope, strict schema, bounded repair. |
| Shared browser/page state | Executor factories create fresh contexts; shared fallback forces serial execution. |
| Generated ID collisions across targets | Target-derived environment and spec prefixes. |
| Concurrent last-result pointer races | Non-selecting worker writes plus one deterministic post-join selection. |
| Trusted replay overwritten by generation | Source-matched trusted scripts and manifests are preserved. |
| Replay completeness checked by count | Exact `(step, expectation)` checkpoint identity set. |
| Previous action target supplied globally | Same spec/environment/step and failure-only lookup. |
| Incomplete/bypassable traces | Persisted tracer always runs, records timings, and closes in `finally`. |

## Open gaps

### G1 — Discovery is still fetch/HTML based

Client-rendered SPAs can expose little useful structure to `parseHtml()`. The
runtime marks sparse crawls degraded, but browser/accessibility-tree discovery
would materially improve arbitrary-app coverage.

Recommended next step: make browser discovery an optional host capability with
the same normalized page-fact contract, then retain fetch as the portable
fallback.

### G2 — Redirect destinations are not first-class aliases

Discovery records the requested path. Redirected content can therefore be
attributed to the pre-redirect route. Preserve both requested and final URLs and
teach route ownership/generation about aliases.

### G3 — Post-action-only states remain difficult to plan cold

A confirmation reachable only after a form submission is absent from fetch
discovery. Unsupported assertions correctly remain open or fail the gate, but a
post-execution observation-to-planner feedback loop would improve the next plan
without inventing copy.

### G4 — The richer `triage()` classifier is not the report classifier

`locator-chain.js` exposes a more detailed classifier, while orchestration uses
a conservative inline mapping. Wire the richer result only after a seeded
defect confusion matrix demonstrates precision and recall.

### G5 — Planner deadline is descriptive, not enforced

Planner envelopes contain `deadlineMs`, but the runtime does not abort a hung
capability. Add an abort signal and persist a partial/fallback decision when the
deadline expires. Native calls also need enforceable per-operation budgets.

### G6 — Similarity is lexical

Sørensen–Dice scoring is transparent and conservative but can miss paraphrases.
An embedding index may improve recall only if same-origin, source-hash, replay
trust, auth-scope, and live-execution guards remain mandatory.

### G7 — Fixture postconditions are not separate replay checkpoints

Trusted replays execute the fixture contract, but coverage identity currently
tracks test-step expectations. Add explicit `(fixture occurrence, expectation)`
checkpoint identities before claiming independently measurable fixture coverage.

### G8 — Cross-process mutable-state locking

Resource locks coordinate workers inside one orchestration. Two orchestration
processes can still race the same account or backend. Add a recoverable
project/account lock or require unique test-data leases.

### G9 — Crash and resume

Atomic writes protect workspace integrity, but an interrupted orchestration does
not resume from its last completed stage. A resumable manifest would need to
revalidate target revision, auth scope, and every referenced content hash.

### G10 — Coverage threshold debt

The functional suite passes 259/259. Repository coverage is 97.46% lines,
83.36% branches, and 93.15% functions against configured 100/95/98 thresholds.
The untouched baseline was already below the gate, but the optimized change does
not claim the gate is green.

## Recommended order

1. Enforced planner/native timeouts and partial reports.
2. Browser/accessibility discovery with normalized evidence parity.
3. Post-action observation feedback for cold planning.
4. Seeded defect confusion matrix, then richer triage wiring.
5. Fixture checkpoint identities.
6. Cross-process state/data leases.
7. Coverage debt and crash/resume.

## Claims to keep precise

- The runtime can fan out host capabilities; it does not create provider agents.
- Parallelism is bounded and resource-aware, not unrestricted.
- A history hit reuses artifacts, never an old verdict.
- A trusted replay still launches a browser and verifies the live application.
- Prompt compression reduces per-worker context; a three-worker cold plan can
  consume more aggregate tokens while reducing latency and increasing breadth.
- The deterministic coverage gate is the critic. There is no hidden model critic.
