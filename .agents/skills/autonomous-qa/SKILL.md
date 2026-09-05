---
name: autonomous-qa
description: Create, inspect, edit, validate, run, safely self-heal, and compare explicit design references for repository-scoped semantic QA specs through native Browser/Chrome or computer-use capabilities.
---

# Autonomous QA — Native execution

Turn UI requirements into human-editable semantic documents under `.qa/`, execute them through the host's native web or desktop capability, and inspect the same files through the optional loopback UI. The complete MVP includes conservative self-healing, explicit-reference design comparison, recent-run retention, validated YAML editing, evidence viewing, safe run deletion, and deterministic demo reset states.

## Create and edit workflow

1. Run `scripts/qa-agent init` from the repository root when `.qa/` is absent. Initialization validates existing content and never overwrites edits.
2. Preserve what the user intends to do and what they should visibly observe. Never add CSS selectors, XPath, DOM paths, coordinates, fixed timing, or tool-specific browser code to specs or fixtures.
3. For a simple one-outcome request, use `scripts/qa-agent create "<requirement>"`. Use `--env`, `--id`, repeatable `--expect`, and repeatable `--fixture-before` when those details were supplied.
4. For a multi-step journey, create complete YAML matching [the spec schema](../../../schemas/spec.schema.json), save it through `scripts/qa-agent spec save <file>`, then select it with `scripts/qa-agent select <spec-id> [--env <id>]`.
5. Finish changes with `scripts/qa-agent validate`. Return the saved path and mention editable assumptions.

Use `spec`, `fixture`, `environment`, and `result` subcommands for `list`, `show`, `validate`, and `save`; specs and fixtures also support guarded deletion. `edit <spec-id>` replaces the authoritative file only after validation succeeds.

## UI and demo workflow

1. Use `scripts/qa-agent ui` from a validated repository workspace to serve the judge-facing page at `http://127.0.0.1:4173`. A different loopback host or port may be supplied with `--host` and `--port`.
2. The UI is a view over `.qa/`, not an execution platform. Copy a test's displayed run command and execute it through the host's native Browser/Chrome or computer-use integration; the page polls for the completed file-backed result.
3. Spec and fixture edits in the UI must preserve the document ID, pass the same schema and cross-file checks as the CLI, and save atomically. Validation errors remain path-based and visible.
4. Inspect result explanations, step statuses, selected accessible targets, healing notes, design findings, and every declared screenshot. Screenshot URLs must resolve only within the selected run and only to evidence declared by that result.
5. Delete only an explicitly selected run. The guarded workspace deletion repairs `last-test.json` to a recent run in the same spec and environment, or removes `lastRunId` when no replacement exists.
6. For this repository's deterministic demo application, start `npm run demo`, then use `npm run demo:reset -- pass|drift|functional|design` before each native run. Reset affects only the loopback demo application's in-memory login, order, and variant state.

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
7. If a test action fails or its target is missing, capture the current state and ask the native executor to rediscover an accessible target from the unchanged intent, current UI, failed/previous target summary, and original expectations. Retry only when the executor explicitly confirms that the replacement is equivalent. Never heal fixture postconditions.
8. If an action succeeded but an expectation may be waiting on UI readiness, use an observable readiness wait only when the native executor exposes it. Re-observe every original expectation afterward; never use a fixed delay.
9. A successful recovery must preserve the expectation list byte-for-byte, capture before/after screenshots, and record the original failure, replacement, strategy, outcome, and verification. Emit `healed` only when all test steps pass and at least one recovery verified the unchanged expectations. If verification still fails, record `functional_regression`; if recovery is unavailable, ambiguous, or blocked, fail safely without guessing a pass.
10. When the spec declares `design`, resolve that explicit image, URL, or Figma reference before execution. At `design.afterStep` (or the last step by default), capture the rendered state at the declared viewport and invoke native design comparison using the fixed focused rules. Require concrete findings for component/content presence, major layout/order/grouping/alignment, or obvious style changes. Minor rendering differences and unsupported opinions cannot produce `design_regression`.
11. Keep functional and design decisions separate. A functional failure remains `functional_regression`; only an otherwise functional run with a supported reference mismatch becomes `design_regression`. Missing comparison capability or evidence blocks the declared design check instead of guessing.
12. Always attempt `after` fixtures in a finally-style cleanup path after pass, failure, healing, design comparison, or cancellation when the native session is usable. Record cleanup failures separately; they must not replace the primary classification.
13. Report console and network errors only when the active native capability exposes them. Otherwise record the inspection as unsupported rather than assuming there were no errors.
14. Save the validated result through the file-backed workspace so `last-test.json` atomically gains `lastRunId`. Return the classification, concise explanation, result path, and screenshot paths.

## Native execution boundary

The repository runtime's executor contract has five semantic responsibilities:

- capability detection for `web` or `desktop`;
- `connect(target)`;
- `act(intent, context)` returning an optional accessible target summary and earlier-run outputs;
- `observe(expectation, context)` returning `passed`, `failed`, or `blocked` plus a visible observation;
- `screenshot(context)` returning PNG, JPEG, or WebP data.

Adapters may additionally expose `rediscover(intent, context)`, `recover(intent, target, context)`, `waitFor(expectation, context)`, and `compareDesign(request, context)`. A rediscovered target is eligible only with `equivalent: true` and an accessible target summary. Design screenshots receive the declared viewport in their screenshot context; comparison returns `matched`, `regression`, or `blocked` plus structured findings. Console inspection, network inspection, and close are optional. Keep adapter-specific details outside `.qa/` documents. Native Browser/Chrome or computer-use tooling is the adapter; Playwright, Stagehand, DOM-selector scripts, coordinate scripts, and fixed sleeps are out of scope.

## Events and results

Emit ordered execution events for run start/completion, environment readiness, capability notices, fixture start/completion, step start/completion, healing start/completion, design start/completion, screenshots, and cleanup. Results must conform to [the result schema](../../../schemas/result.schema.json) and preserve every recorded spec intent and expectation byte-for-byte.

Runs may emit:

- `passed` when declared expectations pass;
- `healed` when interaction mechanics changed and unchanged expectations pass after evidence-backed recovery;
- `functional_regression` for a direct failed action or observable outcome;
- `design_regression` only for a concrete mismatch supported by an explicit reference, actual screenshot, declared viewport, and structured regression finding;
- `blocked` when execution could not reliably proceed.

## Inputs and outputs

- Input: natural-language journey, optional environment, reusable fixtures, explicit expectations, and optional explicit design-reference metadata.
- Output: validated YAML under `.qa/`; validated JSON plus screenshots under `.qa/runs/`; an atomic `.qa/last-test.json` pointer; and an optional localhost view of those same artifacts.
- IDs use lowercase words separated by hyphens and remain stable after creation.

## Safety invariants

- Expectations describe observable outcomes and never change during execution.
- Fixture inputs that may contain secrets remain references such as `${QA_CUSTOMER_PASSWORD}` in stored documents. Resolved values must not enter results, events, terminal output, or screenshots.
- Fixture workflows remain semantic and verify their own postcondition. Cleanup fixtures should be idempotent.
- Unsupported inspection is explicit. Uncertainty never becomes a pass.
- A replacement target must be explicitly equivalent; similarity alone is insufficient.
- Successful healing requires before/after evidence and unchanged-expectation verification.
- A later functional failure overrides an earlier successful healing for the run classification.
- Agent taste alone cannot produce a design regression; every regression requires an explicit reference and concrete finding.
- Design baselines, expected components, and visual findings are never healed or updated automatically.
- Design evidence records the reference, checkpoint, viewport, actual screenshot, and concise comparison result.
- Use native Browser/Chrome for web UI and computer use only for desktop/native UI.
- Keep storage file-backed. Do not add a database, headless CI, scheduling, parallel runs, Playwright, or Stagehand.
- Keep the UI loopback-only. Do not expose it as a remote service, add authentication, or make it a second agent/job platform.
- UI saves must reuse the authoritative validators and preserve document IDs. UI screenshot reads and run deletion must stay inside the selected run directory.
- Demo reset may change only the authorized local demo application's in-memory state; never apply it to staging or production targets.
- Do not heal expected copy, business outcomes, success/error states, fixture postconditions, accessibility expectations, or design baselines. Do not repair application code, update baselines, or perform pixel-perfect diffing.

The schemas in [`schemas/`](../../../schemas/) remain the authoritative structural contracts. The CLI adds cross-file reference checks, execution orchestration, atomic writes, and path-based validation errors.
