# Phase 01 — Foundation

## Summary

Create the smallest durable data model for semantic tests, reusable fixtures, environments, run results, and the most-recent-test pointer. The output of this phase is an inspectable `.qa/` workspace that later phases can execute without changing its core meaning.

## Depends on

- The hackathon product scope in [README.md](../README.md).

## In scope

- Repository-scoped skill skeleton under `.agents/skills/autonomous-qa/`.
- `.qa/` workspace initialization.
- YAML contracts for environments, fixtures, and semantic test specs.
- JSON contracts for run results and `last-test.json`.
- Read, write, list, validate, and update operations.
- Atomic file writes and helpful validation errors.
- Natural-language test drafting into editable YAML.

## Deliverables

- `SKILL.md` with clear triggers, inputs, outputs, and safety invariants.
- A `qa-agent init` operation that creates the minimal workspace.
- Spec, fixture, environment, result, and last-test schema definitions.
- Storage helpers that never require SQLite.
- A sample environment, login fixture, cleanup fixture, and checkout spec.
- Unit tests for parsing, validation, IDs, missing references, and atomic writes.

## Implementation plan

1. Define stable IDs and the minimum required fields for each document type.
2. Implement YAML/JSON parsing with actionable path-based validation errors.
3. Create the `.qa/environments.yaml`, `.qa/fixtures/`, `.qa/specs/`, and `.qa/runs/` layout.
4. Implement CRUD helpers for specs and fixtures.
5. Implement `last-test.json` updates after test selection and completed runs.
6. Add the natural-language-to-spec workflow to the skill instructions.
7. Add representative valid and invalid fixtures for automated tests.

## Key invariants

- Specs store intent and observable expectations, not required CSS/XPath selectors.
- Fixture secrets are environment-variable references, never resolved values.
- Current YAML files remain human-editable and authoritative.
- A failed write cannot leave a partially written spec or last-test pointer.
- Unknown fixtures or environments fail validation before execution.

## Demo checkpoint

Ask the skill to create “a logged-in customer completes checkout.” Show the generated YAML, edit one expectation manually, validate it, and show `last-test.json` pointing to the scenario.

## Exit criteria

- A valid natural-language request produces a valid editable spec.
- Invalid YAML and broken fixture references return useful errors.
- Specs and fixtures can be listed, loaded, edited, and saved.
- `last-test.json` is written atomically and resolves to an existing spec.
- No database or external browser engine is introduced.

## Not in this phase

- Browser execution.
- Self-healing.
- Design comparison.
- Localhost UI.
