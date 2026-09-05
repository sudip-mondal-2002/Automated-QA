# Phase 04 — Design Intelligence and Evidence

## Summary

Add a focused, demoable design check using one explicit reference per test. Persist enough visual and structured evidence for a judge or developer to understand functional, healed, and design-regression results.

## Depends on

- [Phase 03 — Self-Healing and Classification](phase_03_self_healing.md).

## In scope

- Screenshot or prompt-supplied image references.
- Optional Figma frame/link when an existing connector is available.
- Declared viewport capture.
- Presence of required components/content.
- Major layout, order, grouping, alignment, and obvious style comparison.
- `design_regression` classification based only on an explicit reference.
- File-backed recent run history and screenshot evidence.

## Deliverables

- Design-reference resolver.
- Actual screenshot capture at the declared viewport.
- Focused comparison prompt/rules for demoable visual signals.
- `design_regression` result with concise explanation.
- Result writer under `.qa/runs/<run-id>/`.
- Recent-run listing and deletion helpers.

## Implementation plan

1. Resolve and validate the optional design reference before execution.
2. Capture the relevant rendered state at a stable checkpoint.
3. Compare required components, major layout, and obvious visual styling.
4. Separate functional expectation results from design observations.
5. Emit `design_regression` only when the supplied reference supports it.
6. Save reference metadata, actual screenshot, classification, and explanation.
7. Keep only recent runs per the simple hackathon retention rule.

## Key invariants

- Agent taste alone cannot produce a release-blocking design regression.
- Design baselines are never updated automatically.
- A design mismatch does not rewrite functional expectations.
- Evidence must state the viewport and reference used.
- Screenshot capture should avoid exposing configured secret fields.

## Demo checkpoint

Change the checkout page's component order, spacing, color, or variant. Show the supplied reference beside the actual screenshot and the concise `design_regression` explanation.

## Exit criteria

- A matching implementation does not produce a false design regression in the demo.
- An obvious seeded mismatch produces `design_regression` with supporting evidence.
- Functional and design classifications remain distinguishable.
- Recent runs can be listed and deleted without affecting specs or fixtures.
- Results contain enough information to reproduce the comparison.

## Not in this phase

- Pixel-perfect diff infrastructure.
- Automatic Figma library reconciliation.
- Video, traces, or long-term artifact storage.
