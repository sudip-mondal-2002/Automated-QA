# Phase 03 — Self-Healing and Classification

## Summary

Add the product's core differentiator: recover from harmless interaction drift while preserving the original expectation. Introduce a small, explainable classification model that refuses to normalize real bugs.

## Depends on

- [Phase 02 — Native Execution and Fixtures](phase_02_native_execution.md).

## In scope

- Detecting action failure or missing targets.
- Rediscovering an equivalent control from semantic intent and current UI context.
- Handling moved, renamed, or menu-wrapped controls.
- Replacing fixed timing with observable readiness.
- Verifying the original expectation after recovery.
- Classifying runs as `passed`, `healed`, `functional_regression`, or `blocked`.
- Recording concise healing evidence and explanations.

## Deliverables

- Failure classifier with explicit inputs and outcomes.
- Semantic target rediscovery routine.
- Guard that keeps expectations immutable during a run.
- Healing-attempt record containing original failure, selected replacement, and verification result.
- Demo variants for harmless drift and genuine regression.
- Automated tests for the healing boundary.

## Implementation plan

1. Capture the failed intent, current observation, previous target summary, and expected outcome.
2. Decide whether an equivalent interaction is plausibly available.
3. Rediscover and perform only the minimum replacement interaction.
4. Re-evaluate the original expectation without modifying the spec.
5. Return `healed` only when the unchanged expectation passes.
6. Return `functional_regression` when the user-visible outcome remains broken.
7. Store before/after screenshots and a short explanation of the decision.

## Allowed healing

- Moved or renamed controls.
- Equivalent accessible controls.
- Additional safe navigation needed to reach the same destination.
- Readiness waits replacing brittle fixed delays.

## Forbidden healing

- Expected copy or business outcome changes.
- Success/error state changes.
- Fixture postcondition changes.
- Design baseline changes.
- Any change whose only purpose is making the test pass.

## Demo checkpoint

Rename and move the checkout action without changing its behavior. Show the unchanged spec producing `healed`. Then break the confirmation state and show the same spec producing `functional_regression`.

## Exit criteria

- A moved/renamed control is recovered in the demo application.
- The original expectation is byte-for-byte unchanged throughout the run.
- A broken outcome cannot be converted into `healed`.
- Healing evidence identifies what changed and how the result was verified.
- Uncertain cases fail safely instead of guessing a pass.

## Not in this phase

- Design-reference comparison.
- Automatic app-code repair.
- Localhost result visualization.
