---
name: autonomous-qa
description: Create, inspect, edit, validate, and run repository-scoped semantic QA specs and reusable fixtures through native Browser/Chrome or computer-use capabilities. Use when a user describes a UI journey, reusable QA setup, run, or rerun in natural language; do not claim healing or design comparison before their later phases are implemented.
---

# Autonomous QA — Native execution

Turn UI requirements into human-editable semantic documents under `.qa/`, then execute them through the host's native web or desktop capability. Phase 2 supports real actions, observations, fixtures, cleanup, screenshots, events, and structured results. Target healing, design comparison, and the localhost UI remain later-phase work.

## Create and edit workflow

1. Run `scripts/qa-agent init` from the repository root when `.qa/` is absent. Initialization validates existing content and never overwrites edits.
2. Preserve what the user intends to do and what they should visibly observe. Never add CSS selectors, XPath, DOM paths, coordinates, fixed timing, or tool-specific browser code to specs or fixtures.
3. For a simple one-outcome request, use `scripts/qa-agent create "<requirement>"`. Use `--env`, `--id`, repeatable `--expect`, and repeatable `--fixture-before` when those details were supplied.
4. For a multi-step journey, create complete YAML matching [the spec schema](../../../schemas/spec.schema.json), save it through `scripts/qa-agent spec save <file>`, then select it with `scripts/qa-agent select <spec-id> [--env <id>]`.
5. Finish changes with `scripts/qa-agent validate`. Return the saved path and mention editable assumptions.

Use `spec`, `fixture`, `environment`, and `result` subcommands for `list`, `show`, `validate`, and `save`; specs and fixtures also support guarded deletion. `edit <spec-id>` replaces the authoritative file only after validation succeeds.

## Run workflow

Treat `run <spec-id> [--env <id>]` and `run-last` as skill operations. `run-last` must load `.qa/last-test.json` and repeat its exact spec and environment. The Node runtime exposes the same operations when a host integration supplies a native executor; a bare shell process without that capability correctly saves `blocked` instead of pretending to run a UI.

1. Validate and load the spec, selected environment, and every referenced fixture before opening the target.
2. Resolve environment-variable references and earlier `${outputs.*}` values only when needed. Pass resolved fixture inputs directly to the native action; never print or persist their values.
3. Detect the required capability before launch:
   - `type: web` requires native Browser or Chrome control.
   - `type: desktop` requires computer use.
   - If the capability is missing or mismatched, save `blocked` with the precise reason and stop.
4. For a web target, check `baseUrl`. If it is unreachable and the environment declares `startCommand`, start it from the repository root, wait for observable reachability, and stop only the process started for this run after completion. Never start a production target.
5. Open or connect to the resolved target. Execute fixture and test intents using the same semantic action-and-observation loop:
   - Run `before` fixtures in declaration order.
   - After each passing test step, run fixtures declared at that `between.afterStep` boundary.
   - For every intent, observe the current UI, perform the minimum semantic action, and check every declared expectation unchanged.
   - Verify each fixture's top-level `expect` postcondition. An idempotent cleanup fixture passes when the target is already clean.
6. Capture a screenshot after fixture checkpoints and test steps, and at failures. Do not capture credential entry while secret fields are populated. Store screenshots under `.qa/runs/<run-id>/screenshots/` and refer to them with run-relative paths.
7. If an action or expectation fails, stop later test steps. In Phase 2, record a direct expectation failure as `functional_regression` and a capability, environment, login, fixture, or cancellation impediment as `blocked`. Do not rediscover a replacement target or emit `healed`; that belongs to Phase 3.
8. Always attempt `after` fixtures in a finally-style cleanup path after pass, failure, or cancellation when the native session is usable. Record cleanup failures separately; they must not replace the primary classification.
9. Report console and network errors only when the active native capability exposes them. Otherwise record the inspection as unsupported rather than assuming there were no errors.
10. Save the validated result through the file-backed workspace so `last-test.json` atomically gains `lastRunId`. Return the classification, concise explanation, result path, and screenshot paths.

## Native execution boundary

The repository runtime's executor contract has five semantic responsibilities:

- capability detection for `web` or `desktop`;
- `connect(target)`;
- `act(intent, context)` returning an optional accessible target summary and earlier-run outputs;
- `observe(expectation, context)` returning `passed`, `failed`, or `blocked` plus a visible observation;
- `screenshot(context)` returning PNG, JPEG, or WebP data.

Console inspection, network inspection, and close are optional. Keep adapter-specific details outside `.qa/` documents. Native Browser/Chrome or computer-use tooling is the adapter; Playwright, Stagehand, DOM-selector scripts, and coordinate scripts are out of scope.

## Events and results

Emit ordered execution events for run start/completion, environment readiness, capability notices, fixture start/completion, step start/completion, screenshots, and cleanup. Results must conform to [the result schema](../../../schemas/result.schema.json) and preserve every recorded spec intent and expectation byte-for-byte.

Phase 2 may emit only:

- `passed` when declared expectations pass;
- `functional_regression` for a direct failed action or observable outcome;
- `blocked` when execution could not reliably proceed.

The broader schema reserves `healed` and `design_regression` for later phases. Never use either classification yet.

## Inputs and outputs

- Input: natural-language journey, optional environment, reusable fixtures, explicit expectations, and optional design-reference metadata for later phases.
- Output: validated YAML under `.qa/`; validated JSON plus screenshots under `.qa/runs/`; and an atomic `.qa/last-test.json` pointer.
- IDs use lowercase words separated by hyphens and remain stable after creation.

## Safety invariants

- Expectations describe observable outcomes and never change during execution.
- Fixture inputs that may contain secrets remain references such as `${QA_CUSTOMER_PASSWORD}` in stored documents. Resolved values must not enter results, events, terminal output, or screenshots.
- Fixture workflows remain semantic and verify their own postcondition. Cleanup fixtures should be idempotent.
- Unsupported inspection is explicit. Uncertainty never becomes a pass.
- Use native Browser/Chrome for web UI and computer use only for desktop/native UI.
- Keep storage file-backed. Do not add a database, headless CI, scheduling, parallel runs, Playwright, or Stagehand.
- Do not heal targets, compare design references, update baselines, or claim later-phase behavior.

The schemas in [`schemas/`](../../../schemas/) remain the authoritative structural contracts. The CLI adds cross-file reference checks, execution orchestration, atomic writes, and path-based validation errors.
