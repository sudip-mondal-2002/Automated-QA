# Scripts and UI behavior

This repository has two localhost interfaces with different responsibilities. They are intended to run at the same time during the demo.

| Interface | Start command | Default address | Responsibility |
| --- | --- | --- | --- |
| Demo application | `npm run demo` | `http://127.0.0.1:3000` | The deterministic shop that the QA agent tests. |
| QA workspace UI | `npm run ui` | `http://127.0.0.1:4173` | Edits semantic QA documents and displays completed results and evidence from `.qa/`. |

Both servers bind to the local machine. Neither is a hosted service, and the QA UI does not add authentication, a database, scheduling, or a separate test runner.

## What happens when both UIs are running

1. `npm run demo` starts the shop in its stable state. Login and order data exist only in that process's memory.
2. `npm run ui` validates the current `.qa/` workspace before starting the QA dashboard.
3. A demo reset selects one deterministic application state and clears the shop's login/order state.
4. The autonomous-QA skill runs a spec through native Browser/Chrome. Fixtures, steps, observations, healing, design comparison, and screenshots are handled by that native execution path.
5. The completed result is saved under `.qa/runs/<run-id>/`, and `.qa/last-test.json` is updated.
6. The QA UI polls the workspace approximately every 2.5 seconds. The new classification and result card appear automatically after the result file is complete.
7. Selecting the result shows its explanation, step statuses, unchanged expectations, selected accessible targets, healing notes, design findings, and declared screenshots.

The QA UI itself never clicks through the shop or runs a background agent. It remains useful when it is closed: specs, fixtures, CLI operations, and native execution still use the same `.qa/` files.

## Demo application behavior

The demo application is the system under test. It provides login, cart, checkout, confirmation, order cleanup, and an approved confirmation design reference.

Restarting `npm run demo` restores the stable variant because all mutable application state is in memory. The reset command changes only the currently running local demo process.

| Reset command | Spec to run | Expected classification | Visible change |
| --- | --- | --- | --- |
| `npm run demo:reset -- pass` | `checkout-card` | `passed` | The approved checkout journey works normally. |
| `npm run demo:reset -- drift` | `checkout-card` | `healed` | “Proceed to checkout” moves into a menu and becomes “Continue to payment”; expectations remain unchanged. |
| `npm run demo:reset -- functional` | `checkout-card` | `functional_regression` | Checkout interaction works, but the expected confirmation outcome is broken. |
| `npm run demo:reset -- design` | `checkout-design` | `design_regression` | Functional expectations pass, but confirmation order and success styling differ from the explicit reference. |

Reset requires the demo application to be running. To target a non-default local port:

```bash
npm run demo:reset -- design --url http://127.0.0.1:4311
```

The reset helper rejects non-loopback and HTTPS targets so it cannot be used against staging or production.

## QA workspace UI behavior

The workspace UI is a direct view over the repository's `.qa/` directory:

- The tests panel shows each spec's declared environment, last-run environment, and most recent classification.
- Each test provides a copyable run command; the header provides the rerun command.
- The editor loads the real spec or fixture YAML, validates it with the same schema and cross-file checks as the CLI, preserves its document ID, and atomically saves the canonical YAML.
- Validation failures display their document path and explanation without changing the saved file.
- Recent-run cards update through polling after a native run finishes.
- Result detail displays all supported classifications: `passed`, `healed`, `functional_regression`, `design_regression`, and `blocked`.
- Screenshot endpoints serve only files declared as evidence by the selected result.
- Deleting a selected run removes only that `.qa/runs/<run-id>/` directory. If it was the last-run pointer, the workspace selects a recent result from the same spec and environment or removes `lastRunId` when no replacement exists.

Edits and results persist after the QA UI stops because they are files. Unsaved text in the browser does not persist.

### Important execution boundary

The copied `npm run qa-agent -- run ...` command describes the spec and environment to run. A native Browser/Chrome or computer-use adapter must still be supplied by the autonomous-QA host integration.

If the command is executed as a bare shell process without that native capability, the runtime deliberately saves a `blocked` result instead of pretending the UI journey ran. For the intended flow, ask the autonomous-QA skill to run the copied spec and environment.

## Recommended demo sequence

Open two terminals:

```bash
# Terminal 1: application under test
npm run demo

# Terminal 2: QA workspace
npm run ui
```

Then repeat this sequence for each scenario:

```bash
npm run demo:reset -- pass
```

Ask the autonomous-QA skill to run `checkout-card --env local`, then inspect the completed card in the QA UI. Use `drift` and `functional` with the unchanged `checkout-card` spec. Use `design` with `checkout-design`.

## Live developer demo

The current judge-facing package lives in `artifacts/live-demo/`. It follows the same path you should present live:

1. clone and install with ordinary npm;
2. initialize and validate the file-backed QA workspace;
3. create and inspect selector-free semantic YAML;
4. ask Codex to run the spec through the autonomous-QA skill and native Browser;
5. inspect the completed result and screenshots in the workspace UI;
6. rerun the unchanged spec against harmless drift and a real functional bug;
7. run the declared design checkpoint against its explicit reference;
8. close with the repository files and enforced production coverage.

The edited recording is 3:58 because it removes execution waiting. The live presentation reserves five minutes so Browser execution and workspace polling do not force rushed narration. Follow [LIVE_DEMO.md](LIVE_DEMO.md) for the exact timing windows, shell commands, Codex prompts, words to say, and recovery lines.

The terminal sections are recordings of real commands, defined by the VHS tapes in the same directory. Browser sections use real application states and real workspace result details captured from the isolated demo on `127.0.0.1:4312` and QA UI on `127.0.0.1:4190`. Fixture credentials are prepared off-camera, so neither the video nor its source screenshots expose credential fields or a password-save prompt.

`chapters.json` is the conversational narration source. `render-live-demo.mjs` measures each narration file, adds a short lead-in and tail, rounds the chapter to the next 30 fps frame, moves through the real browser states with restrained transitions, and applies the chapter and command callouts. The renderer fails if the encoded duration drifts by more than one frame from the plan or if audio and video end timestamps differ by more than 12 milliseconds.

Delivery files:

- `auto-qa-live-demo.mp4` — 1920×1080, constant 30 fps H.264 video with synchronized AAC narration;
- `auto-qa-live-demo-voiceover.mp3` — the exact normalized narration track from the video;
- `auto-qa-live-demo.vtt` — sentence-level captions constrained to their narration chapters;
- `timing.json` — planned chapters, measured narration, encoded duration, and A/V end delta;
- `contact-sheet.png` — one midpoint from every rendered chapter;
- `02-install.tape`, `03-create.tape`, and `08-correctness.tape` — reproducible real terminal motion;
- `render-live-demo.mjs` — the H.264/AAC assembly and timing validator.

The browser and synthesized voice source files are generated under `artifacts/live-demo/work/`, which is intentionally ignored. The reviewed delivery files above are committed so the demo plays directly from GitHub without requiring the recording environment.

## npm scripts

### `npm run demo`

Starts the deterministic shop on port `3000`.

Arguments are forwarded to the server:

```bash
npm run demo -- --port 4311
npm run demo -- --variant drift
npm run demo -- --variant drift-broken
```

Direct variants are useful when a separate process per state is preferred. The reset workflow is easier for a single live presentation.

### `npm run dev`

Alias for `npm run demo`. It starts the same deterministic shop and is also the local environment's configured `startCommand`.

### `npm run demo:reset -- <scenario>`

Resets the running shop to `pass`, `drift`, `functional`, or `design`. It clears session/order state and selects the corresponding application variant without restarting the server.

### `npm run ui`

Starts the QA workspace on `http://127.0.0.1:4173`. It validates the workspace first and stays active until stopped with `Ctrl+C`.

Use another local port or loopback host through the underlying command:

```bash
npm run qa-agent -- ui --port 4180
npm run qa-agent -- ui --host localhost --port 4180
```

Binding to `0.0.0.0` or another non-loopback host is rejected.

### `npm run qa-agent -- <operation>`

Runs the file-backed QA CLI. Common operations include:

```bash
npm run qa-agent -- init
npm run qa-agent -- create "a logged-in customer completes checkout" --env local
npm run qa-agent -- validate
npm run qa-agent -- spec list
npm run qa-agent -- fixture list
npm run qa-agent -- select checkout-card --env local
npm run qa-agent -- last
npm run qa-agent -- result list
npm run qa-agent -- result show <run-id>
npm run qa-agent -- result delete <run-id>
```

`spec save`, `fixture save`, `environment save`, and `result save` validate before atomically replacing their destination.

### `npm test`

Runs the complete Node.js test suite once.

### `npm run test:coverage`

Runs the suite with production coverage enforcement:

- 100% line coverage;
- at least 95% branch coverage;
- at least 98% function coverage.

The command exits unsuccessfully if a test fails or a coverage gate is missed.

## Stopping and persistence

- Stop either server with `Ctrl+C`.
- Stopping the demo application discards its in-memory login, order, and selected reset state.
- Stopping the QA UI does not delete specs, fixtures, results, screenshots, or the last-test pointer.
- Run deletion from the UI or CLI is intentional filesystem deletion and cannot be undone by restarting the server.
