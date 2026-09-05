# Developer flow, scripts, and UI behavior

## The public workflow

Application developers use one interface: the installed autonomous-QA skill.

```text
$autonomous-qa Set up QA for this app, verify checkout, save evidence, and show me the result.
```

The skill inspects the current application project, creates its `.qa/` workspace, starts or reuses the app, drives native Browser/Chrome or computer use, saves a validated result, and opens the results UI when useful. Developers do not add QA dependencies or scripts to their app and do not run the internal agent runtime.

For follow-up work, use natural language in the same project:

```text
$autonomous-qa Rerun the last test without changing its expectations.
```

```text
$autonomous-qa Show the latest regression and its screenshots.
```

## What happens with the UIs

| Surface | Owner | Purpose | Lifecycle |
| --- | --- | --- | --- |
| Application UI | The developer's project | The system under test | The skill reuses a healthy local process or starts the app's existing dev command. |
| QA workspace UI | The installed skill | Review/edit semantic QA files and inspect completed evidence | The skill starts the packaged loopback server on demand and opens its URL. |

The end-to-end sequence is:

1. The skill validates `.qa/` before touching the application.
2. It checks the configured target URL or desktop app.
3. If a local web target is unavailable and `startCommand` is configured, it starts that command from the application project.
4. Native Browser/Chrome or computer use performs fixtures and test intents and verifies unchanged expectations.
5. The skill writes screenshots and a complete result beneath `.qa/runs/<run-id>/`, then atomically updates `.qa/last-test.json`.
6. The workspace UI polls the files approximately every 2.5 seconds, so a completed run appears without a manual refresh.
7. The skill stops only an app process that it started. The QA artifacts remain in the application repository.

The QA UI never clicks through the application, runs a hidden worker, schedules tests, or keeps database state. It remains optional because `.qa/` is authoritative.

### QA workspace behavior

- The top-level **Workspace** and **Console** tabs are two views over the same `.qa/` files and loopback API.
- Tests show their environment and most recent classification.
- Copy actions return `$autonomous-qa` run/rerun prompts—not internal shell commands.
- The Console exposes a field for every supported `orchestrate` option: target, objective, PRD/plan/output paths, username and password, revision, replan/concurrency limits, and the plan-only, history, remote-authorization, and JSON flags.
- Console composes those fields into an `$autonomous-qa` request and renders the newest pipeline stages, coverage score, planner comparison, scenarios, trace, and declared unknowns from saved orchestration evidence.
- Console credentials are literal and visible in the copied request, so they must be disposable demo-only values. Console never launches a runner, resets the target, or exposes arbitrary adapter commands; the installed skill remains the only execution interface.
- Spec and fixture YAML is validated with the packaged JSON Schemas and cross-file checks before an atomic save.
- Invalid edits stay unsaved and show their exact document path.
- Result detail shows original expectations, observations, selected accessible targets, healing evidence, design findings, and declared screenshots.
- Screenshot requests are confined to files declared by the selected result.
- Deleting a selected run removes only that run directory and repairs the last-run pointer to a recent result from the same spec/environment when possible.
- The server binds only to `127.0.0.1`, `localhost`, or `::1`.

Stopping the workspace UI never deletes tests or evidence. Unsaved browser text is not persisted. An explicitly deleted run is a filesystem deletion and does not return after restart.

## Standalone demo application scripts

These scripts belong to [`demo-app/`](demo-app/), the application under test. They are the only scripts a presenter may show while acting as the application developer.

### `npm run dev`

From `demo-app/`, starts QA Shop on `http://127.0.0.1:3000`.

```bash
cd demo-app
npm run dev
```

The installed skill normally starts this command itself when the target is not already healthy.

### `npm run reset -- <scenario>`

Selects one deterministic application state without restarting the server:

| Scenario | Visible application state | Expected QA classification |
| --- | --- | --- |
| `pass` | Approved checkout flow, no design declaration (D1) | `passed`; no design judgement |
| `drift` | Checkout action moved into a menu and renamed (H1) | `healed` with unchanged expectations |
| `missing-target` | Checkout action removed with no equivalent (H2) | `functional_regression` |
| `functional` | Checkout action works but confirmation outcome changes (H3) | `functional_regression` |
| `fixture` | Login action completes but its postcondition fails (H4) | `functional_regression` |
| `drift-functional` | Drift heals, then confirmation fails (H7) | `functional_regression`; later failure wins |
| `design` | Checkout works but confirmation differs from the explicit reference (D4) | `design_regression` |
| `cleanup` | Checkout passes but the after fixture cannot remove the order (E5) | `passed` with a cleanup issue |
| `locator` | Preferred test IDs disappear but accessible controls remain | locator-chain fallback remains explicit |

```bash
npm run reset -- pass
npm run reset -- drift
npm run reset -- missing-target
npm run reset -- functional
npm run reset -- design
npm run reset -- --list
```

The reset helper accepts only loopback HTTP URLs, clears only in-memory demo state, and cannot target staging or production.

## Internal skill scripts

This section is for skill maintainers and explains what the installed skill owns. These commands should not be presented as application-developer setup.

The portable launcher is:

```text
<installed-skill>/scripts/qa-agent
```

It resolves its own directory and loads the bundled `runtime/qa-agent.mjs`; it never imports the development repository's `src/` or `node_modules/`.

Important internal operations:

- `setup --type web --base-url <url> [--start-command <command>]` creates a project-specific workspace and environment without sample specs.
- `setup --type desktop --app <application>` creates a desktop environment.
- `create`, `spec save`, and `fixture save` persist validated semantic documents.
- `validate` runs schemas plus cross-file checks.
- `run` and `run-last` enter the native executor boundary. A shell-only invocation without that host capability must save `blocked`.
- `result save` persists validated evidence and updates last-test state.
- `ui` starts the packaged reviewer on loopback.

`setup` is idempotent when the existing environment matches and refuses to overwrite different settings. All internal calls pass the application repository through `--root`.

## Maintainer scripts in this repository

### `npm run build:skill`

Bundles `src/skill-runtime.js` and its production dependencies into the installable skill, then copies the authoritative `schemas/` and `ui/` assets. Tests rebuild the package before running so committed install assets cannot silently drift from source.

### `npm test`

Runs the complete Node.js suite. The packaging test installs a copied skill beside an external CommonJS app project whose path contains spaces, then proves setup, semantic creation, native-executor execution, evidence persistence, packaged UI serving, and zero mutation of the app's `package.json`.

### `npm run test:coverage`

Enforces:

- 100% production line coverage;
- at least 95% branch coverage;
- at least 98% function coverage.

### `npm run demo:corners`

Reads the 28 contracts in `docs/corner-test-cases.md`, runs their exact focused
evidence tests, and prints the live reset command for app-backed cases. Use
`npm run demo:corners -- --case H7` for one reviewer-selected challenge or
`npm run demo:corners -- --list` to inspect the matrix without executing it.

### Root demo aliases

`npm run demo`, `npm run dev`, and `npm run demo:reset -- <scenario>` delegate to the standalone `demo-app/` project for maintainer convenience. `npm run demo:reset -- --list` prints the live corner-case catalog. These aliases are not required by an installed-skill user.

## Live developer demo and recording

The current live sequence in [demo.md](demo.md) shows only supported developer actions. [LIVE_DEMO.md](LIVE_DEMO.md) is retained only as the timing script for the existing recording:

1. install the skill from its GitHub directory;
2. open a clean copy of the standalone demo app;
3. submit one `$autonomous-qa` request;
4. watch the skill discover/setup/run the journey through the native browser;
5. inspect file-backed evidence in the workspace UI;
6. change only the demo application's deterministic state and rerun the same semantic expectation;
7. demonstrate `healed`, `functional_regression`, and explicit-reference `design_regression` boundaries.

The deliverables in `artifacts/live-demo/` include the MP4, separate narration, captions, timing manifest, contact sheet, terminal recording sources, voice generator, and renderer. `generate-voiceover.mjs` uses the conversational `en-US-BrianMultilingualNeural` voice by default instead of the operating system's robotic speech voice; `AUTO_QA_DEMO_VOICE` can select another Edge neural voice. The renderer uses measured decoded narration durations, rounds chapters to 30 fps boundaries, and rejects audio/video end drift above 12 milliseconds.
