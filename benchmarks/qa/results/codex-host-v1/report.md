# Auto-QA Core result — codex-host-v1

This is a derived public-label protocol track, not an official upstream leaderboard result. The checked artifacts are independently re-scoreable; this report does not claim a fully rerunnable model evaluation.

| Lane | Primary result |
| --- | ---: |
| Candidate-masked test generation | F1 68.6% · precision 81.7% · recall 59.1% |
| WebTestBench-derived defect verdicts | 37/56 · accuracy 66.1% · F1 61.2% · specificity 78.6% |
| Healing/control conformance | 8/8 safe · true regressions 8/8 protected · false-heal 0.0% |
| Safety-gated composite | **78.1%** |

Composite eligible: **yes**. Evidence artifacts: 237.

## Regression performance by QA dimension

| Dimension | Correct | Accuracy | Fail F1 | Specificity |
| --- | ---: | ---: | ---: | ---: |
| constraint | 10/14 | 71.4% | 66.7% | 85.7% |
| content | 9/14 | 64.3% | 61.5% | 71.4% |
| functionality | 8/14 | 57.1% | 50.0% | 71.4% |
| interaction | 10/14 | 71.4% | 66.7% | 85.7% |

## Runtime disclosure

- Agent: Autonomous QA skill with separate Codex host planner, browser runners, and checklist judges
- Model: Codex GPT-5 family; exact serving snapshot was not exposed to the benchmark runner
- Generation protocol: One candidate-only pass from instruction to at most 20 binary semantic checks, followed by three separate judges. Each judge mapped a prediction to at most one gold check, applied this track's disclosed duplicate-to-null rule, and recorded rationale plus candidate/reference content hashes.
- Regression protocol: Three app-disjoint Codex browser runners each received only stripped candidate cases and pinned rendered WebTestBench apps. Every case used a fresh browser tab, case-unique loopback origin, and restarted app process; runners were instructed not to access reference labels, prior results, source metadata, or the network and self-attested that they did not. Each verdict binds the exact candidate, pinned app archive, actions, observations, confidence, screenshot/DOM evidence, and execution trace.
- Healing protocol: A deterministic, model-free live-DOM semantic adapter evaluated eight ReproBreak-derived local microfixtures and eight paired behavior-regression controls. Recovery never reads the upstream replacement locator in its decision path; this is not an execution of the four upstream applications.
- Execution limitations: Generation predictions and judgments were executed outside a checked-in model runner, and exact planner/judge serving snapshots are unavailable. Regression verdicts are bound to pinned runnable-app archives and recorded action/evidence traces, but browser-runner isolation is operationally instruction-enforced and self-attested rather than cryptographically attested. The healing conformance core is locally rerunnable. This public-label result is content-bound, auditable, and independently re-scoreable, not a fully rerunnable model evaluation or an upstream leaderboard/SOTA claim.
- Public-label disclosure: WebTestBench and ReproBreak labels are public; masking was enforced operationally, but this run is not a secret holdout or SOTA claim
