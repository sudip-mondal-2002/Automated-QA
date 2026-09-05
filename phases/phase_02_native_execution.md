# Phase 02 — Native Execution and Fixtures

## Summary

Run semantic specs against a real local or staging application using native Browser/Chrome. Use computer use only for desktop/native targets. Fixtures share the same execution path as test steps and can run before, after, or between steps.

## Depends on

- [Phase 01 — Foundation](phase_01_foundation.md).

## In scope

- Environment selection and optional local application startup.
- Native capability detection before a run begins.
- Semantic observation and action execution.
- Reusable login, setup, navigation, and cleanup fixtures.
- Fixture inputs sourced from environment variables or earlier run outputs.
- Sequential step execution with observable expectation checks.
- Cleanup execution after pass, failure, or cancellation when possible.

## Deliverables

- `run <spec> --env <environment>` and `run-last` operations.
- Native web executor for Browser/Chrome.
- Native desktop executor boundary for computer use when available.
- Fixture resolver with before/after/between-step support.
- Execution event model for step and fixture progress.
- Basic screenshot capture at checkpoints and failures.
- Integration test against a small deterministic demo application.

## Implementation plan

1. Resolve the selected spec, environment, fixtures, and secret references.
2. Detect whether the target's required native capability is available.
3. Start or connect to the target application and verify reachability.
4. Execute fixture steps through the same semantic action function used by tests.
5. Execute each test intent and evaluate its declared expectations.
6. Record selected targets and observable outcomes without persisting secrets.
7. Run idempotent cleanup fixtures and preserve cleanup failures separately.
8. Persist a basic structured run result and update `last-test.json`.

## Key invariants

- Fixtures are reusable workflows, not Playwright or Stagehand scripts.
- A fixture must verify its own postcondition.
- Cleanup may not overwrite the test's primary result.
- Unsupported console or network inspection is reported, never assumed to pass.
- Resolved secret values are not written to specs, logs, results, or screenshots.

## Demo checkpoint

Run the checkout scenario on the demo app. Show the login fixture establishing the session, the test completing, the cleanup fixture removing the test order, and the saved result.

## Exit criteria

- A local or staging web journey runs end to end through native Browser/Chrome.
- Login and cleanup fixtures are reusable across at least two specs.
- `run-last` repeats the selected spec and environment.
- A missing native capability produces `blocked` with a clear explanation.
- The run produces a structured result and relevant screenshots.

## Not in this phase

- Target self-healing.
- Design-regression classification.
- Full localhost UI.
