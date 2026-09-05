# Deep-dive documentation set

In-depth explanation of the `auto-qa` implementation, originally written as a
presentation set. The orchestration-specific pages 03, 04, and 10 have been
updated for the memory-first parallel runtime. Other numbered pages preserve
useful implementation background but may include pre-optimization counts or
demo observations.

Use these as the authoritative current references:

- [Current orchestration structure](../current-orchestration-structure.md)
- [Optimized agent orchestration](../optimized-agent-orchestration.md)
- [Documentation map](../README.md)

| # | Document | Covers |
| --- | --- | --- |
| 00 | [System overview](00-system-overview.md) | The two products, the governing principle, the repository map, measured status, the correctness contract, scope boundaries |
| 01 | [Harness architecture](01-harness-architecture.md) | All 25 runtime modules, the dependency direction, 10 cross-cutting invariants, the exit-code contract, the two pipelines |
| 02 | [Skill package design](02-skill-design.md) | The one-install skill: bundling, `SKILL.md` as a behavioural contract, launchers, the packaging test, Windows portability |
| 03 | [Agents, capability seats, and parallel decomposition](03-agents-and-subagents.md) | Host/runtime boundary, route-owned planner workers, exact capability context, scheduling and lifecycle visibility |
| 04 | [Current orchestration pipeline](04-orchestration-pipeline.md) | Fingerprint → memory → probe → concurrent discovery/planning → gate → generation → locked execution → report |
| 05 | [Execution, healing, design, safety](05-execution-healing-safety.md) | `executeRun()` end to end, fixtures, the healing machine, design comparison, evidence, the event journal, the governance audit |
| 06 | [Storage, schemas, evidence](06-storage-schemas-evidence.md) | The `.qa/` layout, all 10 contracts, the 30+ workspace guards, the 15 `saveResult` guards, the secret path |
| 07 | [UI, CLI, developer surface](07-ui-cli-surface.md) | 20 CLI commands, the loopback API, the reviewer front end, the demo app and its scenario switch, demo assets |
| 08 | [Testing and demos](08-testing-and-demos.md) | real test and coverage numbers, test infrastructure, the executable 28-case corner matrix, six verification levels, missing tests |
| 09 | [Presentation outline](09-presentation-outline.md) | 22 slides with content and speaker notes, plus 8 appendix slides |
| 10 | [Current gaps and roadmap](10-gaps-and-roadmap.md) | Optimization closures, remaining technical gaps, work order, and precise claim boundaries |

## Fastest path to a deck

1. Read **00** for framing and the numbers.
2. Read **03** — it is the conceptual core and supplies three of the best diagrams.
3. Build from **09**, but replace historical orchestration numbers and diagrams
   with the current structure and benchmark documents linked above.
4. Keep **10** open during Q&A.

## Diagrams available to lift

| Diagram | Location |
| --- | --- |
| Two products, one engine | [00 §1](00-system-overview.md) |
| Module dependency map | [01 §1](01-harness-architecture.md) |
| Two pipelines, one engine (sequence) | [01 §5](01-harness-architecture.md) |
| Skill invocation (sequence) | [02 §4](02-skill-design.md) |
| The agentic model — host / meta-agent / seats / rails | [03 §1](03-agents-and-subagents.md) |
| Planner sub-agent protocol (sequence) | [03 §3.1](03-agents-and-subagents.md) |
| Healing state machine | [03 §5](03-agents-and-subagents.md) |
| Task-decomposition funnel | [03 §7](03-agents-and-subagents.md) |
| The 8-stage pipeline | [04](04-orchestration-pipeline.md) |
| `executeRun()` lifecycle | [05 §1](05-execution-healing-safety.md) |
| Secret flow | [06 §4](06-storage-schemas-evidence.md) |
| Verification levels | [08 §5](08-testing-and-demos.md) |

## Existing repository docs these build on

- [`README.md`](../../README.md) — the public pitch and install path
- [`docs/README.md`](../README.md) — current/historical documentation routing
- [`docs/current-orchestration-structure.md`](../current-orchestration-structure.md) — exact optimized implementation
- [`docs/optimized-agent-orchestration.md`](../optimized-agent-orchestration.md) — audit and measured results
- [`docs/architecture.md`](../architecture.md) — the as-implemented orchestrator diagram
- [`docs/ORCHESTRATOR_DEMO.md`](../ORCHESTRATOR_DEMO.md) — the 5-minute orchestration demo script
- [`docs/corner-test-cases.md`](../corner-test-cases.md) — the executable 28-case sub-agent corner matrix
- [`docs/prd.md`](../prd.md) — the demo app's PRD (used for PRD-gap analysis)
- [`demo.md`](../../demo.md) — the current judge-facing demo runbook
- [`LIVE_DEMO.md`](../../LIVE_DEMO.md) — timing script for the existing recording
- [`docs/challenge-alignment.md`](../challenge-alignment.md) — official-requirement and submission traceability
- [`scripts.md`](../../scripts.md) — lifecycle and persistence behaviour
- [`phases.md`](../../phases.md) + [`phases/`](../../phases/) — the 5-phase roadmap (all complete)
- [`TODO.md`](../../TODO.md) — the working gap list
- [`exp_1.md`](../../exp_1.md) — branch review notes with measured evidence
