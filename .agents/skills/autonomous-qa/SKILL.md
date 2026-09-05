---
name: autonomous-qa
description: Set up and run repository-scoped semantic QA end to end through native Browser, Chrome, or computer-use capabilities, including evidence, conservative self-healing, design comparison, reruns, and the local results UI.
---

# Autonomous QA — one-skill developer experience

The developer installs this skill once, opens their application repository, and describes the journey to test. Own the rest of the QA lifecycle: inspect the app, initialize its `.qa/` workspace, create or update semantic tests, start or reuse the application, execute through the native UI capability, persist validated evidence, and open the local results UI when useful.

## Developer contract

- Keep the developer in their application repository. Do not ask them to clone this skill's source repository, install its npm dependencies, add a QA package or script, or operate an agent runtime.
- Treat `$autonomous-qa ...` natural-language requests as the public interface. The launcher and runtime described below are internal implementation details.
- Do not tell the developer to run `qa-agent`, `npm run qa-agent`, or a separate QA UI command. Run those internally when needed.
- Do not modify application code while testing unless the developer explicitly asks for a product fix. Writing `.qa/` artifacts in the application repository is expected.
- Summarize the saved spec, classification, evidence paths, and any actionable regression. Avoid narrating internal plumbing.

## Self-contained runtime

Resolve `SKILL_ROOT` as the directory containing this `SKILL.md`. This installed directory contains everything the skill needs:

- `scripts/qa-agent` — POSIX internal launcher;
- `scripts/qa-agent.cmd` — the same launcher for Windows shells;
- `runtime/qa-agent.mjs` — bundled Node.js runtime and dependencies;
- `schemas/` — authoritative document contracts;
- `ui/` — loopback workspace assets.

Invoke the launcher from the application repository and always pass its root explicitly:

```bash
"$SKILL_ROOT/scripts/qa-agent" <operation> --root "$PWD"
```

On Windows use `"%SKILL_ROOT%\scripts\qa-agent.cmd"` from a shell. When invoking the runtime programmatically rather than through a shell, prefer the launcher-free form, which works identically everywhere and avoids the Node restriction on spawning `.cmd` files without a shell:

```bash
node "$SKILL_ROOT/scripts/qa-agent.mjs" <operation> --root "$PWD"
```

Quote both the launcher and every argument: the skill is often installed under a path containing spaces.

The application needs Node.js 20 or newer, but it does not need to install the skill runtime's npm dependencies. Never resolve files outside `SKILL_ROOT` for normal operation.

## First request in an application

1. Inspect only enough project metadata to identify the application type, existing start command, and local target. Prefer an already documented development command and URL. Never invent or run a production deployment command.
2. If `.qa/environments.yaml` is absent, initialize a project-specific workspace internally:
   - Web: `setup --type web --base-url <loopback-url> [--start-command <existing-command>]`
   - Desktop: `setup --type desktop --app <existing-application>`
   - Add `--environment <stable-id>` when `local` is not the right name.
3. `setup` must not seed this package's demo fixtures or sample checkout tests. It is idempotent and must refuse to overwrite a differently configured environment.
4. Translate the requested journey into semantic YAML. Preserve what the user intends to do and what they should visibly observe. Never add CSS selectors, XPath, DOM paths, coordinates, fixed timing, or tool-specific browser code. Use optional `channel: web|chat|voice|workflow|api` per step when the journey spans conversational, voice, agentic-workflow, or API surfaces; omit it for plain web UI. The channel is part of the contract and must never change during healing or reruns.
5. For one simple outcome, use internal `create [--channel <channel>]`. For a multi-step journey, write YAML matching `schemas/spec.schema.json` and save it through internal `spec save`.
6. Create fixtures only for genuinely reusable setup or cleanup. Store secrets as references such as `${QA_CUSTOMER_PASSWORD}`; never place resolved values in YAML, output, screenshots, or results.
7. Run internal `validate` before opening the target. Surface path-based validation problems rather than weakening a contract.

## End-to-end run workflow

The skill, not the developer, performs every step below.

1. Load the selected spec, environment, and referenced fixtures. `run-last` means the exact spec and environment in `.qa/last-test.json`.
2. Detect the required native capability before launch:
   - `type: web` requires Browser or Chrome control.
   - `type: desktop` requires computer use.
   - If the required capability is unavailable, save `blocked` with the precise reason. Never imply that a shell-only run drove a UI.
3. For web targets, check `baseUrl`. When a loopback target is unreachable and `startCommand` exists, start it from the application repository, wait for observable reachability, and remember whether this skill started the process. Reuse an already healthy target.
4. Connect to the target and execute fixture and test intents through the native capability:
   - run `before` fixtures in declaration order;
   - after each passing step, run fixtures at that `between.afterStep` boundary;
   - observe the current UI, perform the minimum semantic action, and verify every declared expectation unchanged;
   - verify each fixture's top-level postcondition.
5. Capture evidence after fixture checkpoints and test steps, and at failures. Do not capture credential entry while secret fields are populated. Save images only under `.qa/runs/<run-id>/screenshots/` and use run-relative paths in the result.
6. When an action fails or its target is missing, capture current state and rediscover from the unchanged intent, current UI, failed or previous accessible target, and original expectations. Retry once only when the replacement is explicitly equivalent. Never heal a fixture postcondition.
7. When an action succeeds but the expected UI may still be settling, wait only on an observable readiness condition supported by the native capability. Never use a fixed sleep.
8. A successful recovery must retain the expectation list byte-for-byte, capture before and after evidence, and record the failed target, equivalent replacement, strategy, retry outcome, and verification.
9. If the spec declares `design`, resolve the explicit image, URL, or Figma reference. At the declared checkpoint, capture the actual viewport and compare only component/content presence, major layout/order/grouping/alignment, and obvious style changes. Record structured findings and provenance.
10. Always attempt `after` fixtures in a finally-style cleanup path while the native session remains usable. Cleanup failure is separate and must not replace the primary classification.
11. Save a result matching `schemas/result.schema.json`, update `.qa/last-test.json` atomically, and keep recent-run retention intact. Report console and network errors only when the native capability exposes them; otherwise record that inspection as unsupported.
12. Stop only an application process started for this run. Preserve `.qa/` artifacts and any already-running developer process.

## Autonomous orchestration

`orchestrate` is the second entry point: a URL is the only required input, and the runtime probes the target, crawls it, plans, generates, executes, triages, and reports. Run it internally the same way as every other operation.

```bash
node "$SKILL_ROOT/scripts/qa-agent.mjs" orchestrate --url <loopback-url> --root "$PWD"
```

The runtime supplies the rails — the crawl, the coverage gate, the generator, the executor contract, the schemas, the trace. It supplies **no judgement**, and it never calls a model. Judgement is a capability the skill provides, exactly as native UI execution already is. Where a stage needs judgement and no capability is available, the runtime falls back to a deterministic path and records that it did so. It does not guess and it does not stall.

## Planner sub-agent

When `orchestrate` reaches the planning stage it needs a test plan for an application neither it nor anyone else has seen. Act as the Planner.

1. The runtime hands over a brief: the crawled site map rendered as structure and observable strings, the developer's natural-language focus, and any PRD requirements. Read `plan-draft.schema.json` in `SKILL_ROOT/schemas/` — it is the authoritative contract for what to return.
2. Produce a plan draft as JSON matching that schema. Hand it back either in process, as the `planner` capability, or on disk with `--plan <file>`.
3. The runtime validates every draft against the schema before trusting it. A rejected draft comes back once with the specific reasons; correct exactly those and return the corrected document. After a second rejection the runtime falls back to its deterministic planner and records the reason in `plan.source`.

What makes a plan worth generating tests from:

- Cover happy paths, error states, and edge cases. A plan that is only happy paths is a failed plan.
- Prefer real multi-step journeys over disconnected single clicks. If the crawl shows cart → checkout → confirmation, that is one flow with ordered steps.
- Every form deserves at least one success case and one rejection case.
- Plan a guard for destructive or money-moving actions — double submission, confirmation required.
- Mark a flow that needs a session with `authenticated` in `preconditions`.

**The assertion rule is the one that matters.** Each expectation carries `prose` — what a human would write — and an optional `assert` predicate that a browser can evaluate. The predicate's value must be a string you have reason to believe literally appears in the rendered page, taken from the crawled titles, headings, link text, and button labels you were given.

Never copy the prose into the predicate. *"Order confirmation is visible"* is a description of an outcome, not text the application renders; asserting it can only ever fail. If the crawl shows the heading is "Thank you for your order", that is the value.

When you cannot determine the observable text — most often because a page is reachable only after an action the crawl never performed — do one of these, in order of preference: assert `url_contains` with the path you expect to land on; omit the predicate and leave the prose alone; or say so in `openQuestions`. An expectation with no predicate is honest and the generator marks it `UNVERIFIED`. A predicate you invented is not, and generation will refute it against the live page anyway.

Record what you could not determine in `openQuestions` rather than resolving it by assumption. That list survives into the plan and the report, and it is how ambiguity stays visible instead of becoming a false claim of coverage.

## Classification boundary

- `passed`: every declared expectation passed with no recovery.
- `healed`: interaction mechanics drifted, one evidence-backed equivalent retry succeeded, and every original expectation passed unchanged.
- `functional_regression`: an action or observable product outcome failed. Do not heal expected copy, business outcomes, success/error states, fixture postconditions, or accessibility expectations.
- `design_regression`: functionality passed, but an explicit reference and actual screenshot support concrete design findings.
- `blocked`: execution or a declared check could not proceed reliably.

A later functional failure overrides earlier healing. Missing comparison evidence blocks a declared design check. Uncertainty never becomes a pass, and design baselines are never updated automatically.

## Results UI

Start the packaged UI internally after a run when the user asks to inspect evidence, when a regression benefits from visual review, or during a demo. Use internal `ui` with a free loopback port if the default is busy, then open the returned URL.

The UI is a file-backed reviewer, not a second agent platform. It:

- lists specs, environments, classifications, and recent results;
- copies `$autonomous-qa` run and rerun prompts rather than shell commands;
- validates and atomically saves spec or fixture YAML;
- polls for completed result files;
- shows expectations, observations, accessible targets, healing notes, design findings, and declared screenshots;
- deletes only an explicitly selected run and safely repairs the last-run pointer.

The UI never drives the application, schedules jobs, or exposes a remote service. Keep it loopback-only.

## Internal document operations

Use `spec`, `fixture`, `environment`, and `result` subcommands for internal `list`, `show`, `validate`, and `save`; specs and fixtures also support guarded deletion. `edit <spec-id>` replaces the authoritative file only after validation succeeds. All saves must reuse the packaged validators and atomic write path. Use internal `audit <run-id>` to print the governance checklist (unchanged expectations/channels, healing evidence, design findings, screenshot declarations) before presenting evidence to judges or enterprise reviewers.

The schemas in `schemas/` are authoritative. IDs use lowercase words separated by hyphens and remain stable after creation.

## Safety invariants

- Expectations and channels describe observable outcomes and remain unchanged during execution and healing.
- Resolved fixture secrets never enter documents, results, events, terminal output, or screenshots.
- Replacements require explicit semantic equivalence; similarity is insufficient.
- Healing requires before/after evidence and unchanged-expectation verification.
- Agent taste cannot create a design regression; explicit reference evidence and concrete findings are required.
- Do not repair application code, update design baselines, or perform pixel-perfect diffing while running QA.
- Keep storage file-backed. Do not add a database, headless CI, scheduling, parallel runs, Stagehand, DOM-selector scripts, coordinate scripts, or fixed sleeps.
- The runtime never adds a Playwright dependency and never drives a browser itself. `orchestrate` emits `generated/*.spec.js` as portable artifacts for the developer's own runner; execution always goes through the native capability and the semantic spec stays the contract.
- **The runtime never calls a language model.** It ships no provider client, reads no API key, and makes no outbound request except to the target under test. Judgement — planning, rediscovery, design comparison — is a capability this skill supplies as a sub-agent. Where the capability is absent, the runtime falls back to a deterministic path and records that it did.
- A plan draft is validated against `plan-draft.schema.json` before anything is generated from it. Never widen the schema to accommodate a draft; correct the draft.
- Do not expose the UI beyond loopback or turn it into an execution service.
