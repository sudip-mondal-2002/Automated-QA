# Documentation map

## Current implementation

These documents describe the code on the optimized orchestration branch:

1. [Current orchestration structure](current-orchestration-structure.md) — exact
   runtime topology, dispatch algorithm, concurrency controls, capability
   envelopes, memory invalidation, and artifact layout.
2. [Optimized agent orchestration](optimized-agent-orchestration.md) — audit
   findings, before/after decisions, prompt compression, benchmarks, verification,
   and remaining constraints.
3. [Orchestrator architecture](architecture.md) — compact system diagram and
   module boundaries.
4. [Orchestrator demo](ORCHESTRATOR_DEMO.md) — maintainer demo flow.
5. [Corner test cases](corner-test-cases.md) — executable adversarial contracts.
6. [Challenge alignment](challenge-alignment.md) — traceability from the official
   must-haves, evaluation weights, scope boundary, and submission checklist to
   concrete code and evidence.

Raw benchmark evidence is in [`benchmarks/`](benchmarks/). Both the baseline and
optimized files contain every measured invocation, trace stage, replay attempt,
execution mode, and artifact hash.

## Product and demo references

- [Demo application PRD](prd.md)
- [Developer README](../README.md)
- [Current judge demo runbook](../demo.md)
- [Recorded-video timing script](../LIVE_DEMO.md)
- [Lifecycle notes](../scripts.md)

## Historical presentation set

The numbered [`explain/`](explain/) documents were originally written as a
presentation snapshot. The index now routes current orchestration claims to the
two authoritative documents above. Pages that preserve pre-optimization numbers
or behavior are labeled as historical and should not be used as evidence for the
current runtime.
