# Phase 05 — UI and Demo Integration

## Summary

Build the smallest localhost experience that makes the product legible during the hackathon, then integrate and rehearse the four proof scenarios. The UI reads and writes the file-backed workspace; it does not introduce a database or separate agent platform.

## Depends on

- [Phase 04 — Design Intelligence and Evidence](phase_04_design_intelligence_and_evidence.md).

## In scope

- One localhost page for tests, editing, and recent runs.
- Integrated **Workspace** and **Console** tabs; no standalone demo UI or runner.
- Console fields for the URL, optional intent/PRD/credentials, and every supported orchestration flag.
- Spec/fixture YAML editing with validation feedback.
- Last status and environment per test.
- Copyable `$autonomous-qa` run/rerun requests.
- Screenshot and result explanation viewer.
- Run deletion.
- End-to-end integration and demo-state reset.
- Clear handling of blocked, failed, healed, and design-regression states.

## Deliverables

- `qa-agent ui` command.
- URL-first Console prompt composer and orchestration decision dashboard.
- Tests panel, YAML editor, and recent-runs panel.
- Result detail view with step statuses, screenshots, selected target, and explanation.
- Demo application states for pass, harmless drift, functional bug, and design mismatch.
- Seed/reset script or fixture for restoring each demo state.
- Final README instructions for running the demo.

## Implementation plan

1. Serve a local API over the existing file-backed workspace helpers.
2. Build the tests list with environment, last run, and copyable commands.
3. Add YAML editing and reuse the Phase 01 validator.
4. Add recent-run cards and a focused result detail view.
5. Add safe deletion for one selected run directory.
6. Wire live refresh or simple polling while a run writes its result.
7. Integrate the orchestration controls, coverage dashboard, and explorer into the same UI.
8. Create deterministic demo reset states.
9. Rehearse all four scenarios from a clean checkout.

## Demo checkpoint

Run the complete judge-facing flow from a clean demo state and show each classification in the localhost UI.

### Demo scenarios

1. **Create and pass** — generate a spec, reuse login, run, and inspect the passing result.
2. **Heal harmless drift** — move/rename a control and show `healed` with the same expectation.
3. **Reject a real bug** — break the outcome and show `functional_regression` without assertion changes.
4. **Detect a design regression** — seed a visible mismatch and show reference-backed evidence.

## Key invariants

- The UI remains optional; skill operations still work without it.
- Console composes requests; only the installed skill executes them.
- The UI does not store a second copy of specs or results.
- A run deletion cannot escape its `.qa/runs/<run-id>/` directory.
- Demo reset tooling affects only the authorized demo application/data.
- Judge-facing explanations are short, concrete, and evidence-linked.

## Exit criteria

- Specs and fixtures can be viewed, edited, validated, and saved in the UI.
- Recent results and screenshots render correctly for every classification.
- A selected run can be deleted safely.
- All four demo scenarios work from a documented clean state.
- The README acceptance checklist passes end to end.
- No explicitly out-of-scope platform feature was added.

## Optional polish after the completion gate

- Let the coding agent patch the seeded functional bug and rerun the unchanged test.
- Improve visual presentation and transitions without expanding product scope.
