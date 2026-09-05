# Human-reviewed analysis — native-chrome-v2

The run was strongest on medium difficulty (7/7) and completed five of seven
Level-3 workflows. Four of seven domains were perfect. The fixed denominator retains
all three misses:

- `8d1a19339800ac51` reached a valid final state, but the visible result came from
  incorrectly derived visual inputs.
- `a81115d13618fcec` completed the workflow, but the recorded code omitted the visible
  leading `#` character.
- `541e77c05263f156` ended at an application validation error rather than the intended
  completion state.

An independent evidence audit found all 21 screenshots non-empty and task-consistent.
Twenty screenshots visibly contain the returned code. `75a6cd75b0335547` shows the
processed final table, but its returned code is outside the captured viewport; its
correctness is independently auditable from the submitted and expected hashes in the
published result.

For directional context only, the highest row in WebForge's pinned upstream table is
Gemini-3-Pro (Screenshot + DOM): 75.9% overall and 58.0% on Level 3 across all 934
tasks. That protocol includes direct-answer, operation-code, and mixed tasks evaluated
by a semantic LLM judge. This result instead uses 21 selected non-stochastic
operation-code tasks and exact normalized-code scoring, so no percentage-point, rank,
outperformance, or state-of-the-art comparison is valid.

This is a recorded Auto-QA demonstration run, not a fully reproducible model score:
the host did not expose an exact deployed model identifier or reasoning setting to the
benchmark harness, and execution was split across three parallel Codex task runners.
