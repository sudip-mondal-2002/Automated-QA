# 07 — UI, CLI and developer surface

> Historical CLI/UI snapshot. Current orchestration adds `history query`,
> history/revision controls, and bounded crawl/planner/execution concurrency.
> See [Current orchestration structure](../current-orchestration-structure.md).

Everything a human (or a host agent acting for one) actually touches.

---

## 1. Three surfaces, clearly separated

| Surface | Owner | Purpose | Lifecycle |
| --- | --- | --- | --- |
| **The application UI** | The developer's project | The system under test | The skill reuses a healthy local process, or starts the app's own dev command |
| **The QA workspace UI** | The installed skill | Review/edit semantic QA files, inspect completed evidence, read the orchestration decision timeline | Started on demand, loopback only |
| **The CLI** | The skill (internal) | 20 operations the host agent calls; not a developer-facing product | Invoked with `--root "$PWD"` |

The workspace UI **does not** execute tests, schedule jobs, keep a second copy of
state, or expose a remote service. Its copy buttons emit `$autonomous-qa` prompts,
not shell commands — reruns go back through the agent, so the developer never learns
an internal command line.

---

## 2. The CLI (`src/cli.js`, 20 commands)

```
qa-agent init [--empty] [--root <repository>]
qa-agent setup --type <web|desktop> [--environment <id>] [--base-url <url>]
               [--start-command <command>] [--app <application>]
qa-agent create <requirement> [--id <id>] [--env <id>] [--expect <text>]...
               [--channel <web|chat|voice|workflow|api>] [--fixture-before <id>]...
qa-agent orchestrate --url <url> [--username <u>] [--password <p>] [--prompt <text>]
               [--prd <file>] [--plan <file>] [--plan-only] [--out <dir>]
               [--max-replans <n>] [--allow-remote] [--json]
qa-agent spec        <list|show|validate|save|delete> [id|file]
qa-agent fixture     <list|show|validate|save|delete> [id|file]
qa-agent environment <list|show|validate|save>        [id|file]
qa-agent result      <list|show|validate|save|delete> [run-id|file]
qa-agent run <spec-id> [--env <id>]
qa-agent run-last
qa-agent audit <run-id>
qa-agent ui [--host <loopback-host>] [--port <port>]
qa-agent select <spec-id> [--env <id>]
qa-agent last
qa-agent edit <spec-id>
qa-agent validate
```

### Notable command behaviour

**`init`** seeds a demo workspace (3 sample specs, 2 fixtures, 3 environments);
`--empty` skips the samples. It is idempotent — existing files are *validated and
kept*, never overwritten.

**`setup`** is the one the skill uses in a real app: it creates a
project-specific environment and **never seeds demo samples**. Idempotent when the
existing environment matches; refuses with `ENVIRONMENT_EXISTS` when it differs,
telling the developer to edit `environments.yaml` explicitly. Validates option
combinations (`--app` is desktop-only; `--base-url`/`--start-command` are web-only).

**`create`** turns one sentence into a valid spec via `draftSpec()`:
- strips filler prefixes (`a|an|the|test that|verify that|ensure that`);
- slugifies the title into a stable id;
- **infers the channel** from the wording (`chat|conversation|support agent` → chat;
  `voice|call|ivr` → voice; `workflow|pipeline|approval` → workflow;
  `api|endpoint|webhook` → api; else web);
- **infers the expectation** when none is given (checkout/purchase → "Order
  confirmation is visible"; login → "Customer dashboard is visible"; register →
  "Account confirmation is visible"; search → "Relevant search results are visible";
  add-to-cart → "The selected item is visible in the shopping cart"; update/edit →
  "The saved changes are visible"; fallback → "The requested outcome is visible to
  the user");
- **auto-attaches the login fixture** when the requirement says "logged in" or
  "authenticated" *and* `login-customer` actually exists;
- then saves and selects it.

**`edit <spec-id>`** stages the spec to a temp file, opens `$VISUAL`/`$EDITOR`
(`notepad` on Windows, `vi` elsewhere) with `shell: true` on win32, and **only saves
if validation passes**. The temp file is always unlinked.

**`run` / `run-last`** stream execution events to stdout as
`type\tsubject\tstatus`, then print `runId\tclassification\texplanation`. Exit 0 for
`passed`/`healed`, 1 otherwise. Without a host-native executor a shell `run`
deliberately saves **blocked** — *"only the installed skill's native execution flow
may claim that it drove the UI."*

**`orchestrate --plan <file>`** is the file-based half of the planner capability: a
draft on disk becomes `planner = async () => draft`. Because it is the same document
every time, a rejection falls back rather than looping on an unchanging file.

**`audit <run-id>`** prints the 10-check governance checklist (see
[05 §9](05-execution-healing-safety.md)).

### Argument parsing
Hand-rolled and strict: `option()` throws `MISSING_OPTION_VALUE` when a flag is last
or followed by another flag; `options()` collects repeats; `flag()` splices;
`assertNoUnknownOptions()` rejects any leftover `--x`; leftover positionals throw
`UNKNOWN_ARGUMENT`. `-` as a file argument reads **stdin**. Every error surfaces
through `formatQaError` with its path-based issues.

---

## 3. The workspace UI server (`src/ui-server.js`)

### Binding and hardening
- Default `127.0.0.1:4173`; `assertUiAddress` allows only `127.0.0.1`, `localhost`,
  `::1` (`INVALID_UI_HOST`) and ports 0–65535 (`INVALID_UI_PORT`).
- Every response carries:
  ```
  content-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self';
    script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
    frame-ancestors 'none'
  cache-control: no-store
  referrer-policy: no-referrer
  x-content-type-options: nosniff
  x-frame-options: DENY
  ```
- Request bodies capped at **1 MB** → `REQUEST_TOO_LARGE` (413).
- `QaError` codes map to status: `NOT_FOUND`→404, `METHOD_NOT_ALLOWED`→405,
  `REQUEST_TOO_LARGE`→413, `ID_MISMATCH`/`SPEC_SELECTED`/`FIXTURE_IN_USE`→409,
  anything else→422, non-`QaError`→500 with a generic message (no internal leakage).

### API surface

| Method | Route | Behaviour |
| --- | --- | --- |
| GET | `/api/health` | `{ status: "ready" }` |
| GET | `/api/workspace` | Full summary: tests (with `lastStatus`, `lastEnvironment`, `runPrompt`), fixtures, environments, selected pointer, `rerunPrompt`, and the 50 most recent runs |
| GET | `/api/documents/{specs\|fixtures}/{id}` | `{ kind, id, title, yaml }` — the **raw file text**, so the editor shows exactly what is on disk |
| PUT | `/api/documents/{specs\|fixtures}/{id}` | Validate → assert the id did not change → atomic save → return the re-serialized document |
| POST | `/api/documents/{specs\|fixtures}/validate` | Validate without saving |
| GET | `/api/runs/{runId}` | Full `result.json` |
| DELETE | `/api/runs/{runId}` | Delete exactly one run and repair the pointer |
| GET | `/api/runs/{runId}/screenshots/{file}` | **Only** if the path is listed in that run's `evidence.screenshots`, else 404 |
| GET | `/api/orchestrations` | All orchestrations, newest first: verdict, exit code, score, scenario counts, planner |
| GET | `/api/orchestrations/{id}` | The whole decision record: report + gate checklist + gaps + untested risks + open questions + plan source + planned flows |
| GET | `/api/orchestrations/{id}/trace?since=N` | Trace events after seq N, re-redacted on read |
| GET | `/`, `/app.js`, `/styles.css` | The three static assets, from the packaged `ui/` directory |

The trace reader **tolerates a truncated final line** — a run killed mid-write leaves
a partial JSON line, which is skipped rather than failing the whole timeline.

---

## 4. The UI front end (`ui/app.js`, 588 lines, zero dependencies)

No framework, no build step, no bundler — a single ES module using `fetch` and
`document.createElement` through a tiny `node(tag, options, children)` helper.

### Layout
```
┌─ topbar: brand · connection status · "Copy rerun prompt" · refresh ────────┐
├─ intro: headline + summary strip (tests · recent runs · environments) ─────┤
├─ Library ──────────┬─ YAML editor ─────────────┬─ Recent runs ─────────────┤
│ tests + status     │ validate / save           │ auto-refreshing cards     │
│ reusable fixtures  │ path-based error messages │                           │
├────────────────────┴───────────────────────────┴───────────────────────────┤
│ Result detail: metadata · steps & observations · screenshots · findings    │
├────────────────────────────────────────────────────────────────────────────┤
│ Autonomous orchestration — decision timeline (hidden when none exist)      │
│  list │ metadata · coverage gate · stage timeline · flows · scenarios ·    │
│       │ declared unknowns                                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

### Behaviours worth demoing
- **Polling every 2.5 s**, but only while `document.visibilityState === "visible"` —
  a completed run appears without a manual refresh, and a hidden tab costs nothing.
- **Copy buttons emit agent prompts**, e.g.
  `$autonomous-qa Run checkout-card on local through the native UI capability and save the result and evidence.`
- **Editing is validate-then-save.** Any edit marks "Unsaved changes"; `Save` runs
  validation first and surfaces the exact document path on failure
  (`Spec YAML from UI could not be parsed — $.steps[0].expect: must NOT have fewer than 1 items`).
- **Result detail** renders per step: intent, status badge, every expectation with its
  observation, the **selected accessible target**, and the healing note
  (`Healing: Continue to payment — The original expectations passed unchanged after recovery`),
  then the screenshot grid and any design findings.
- **The orchestration panel** is the "show your work" surface:
  - *Metadata* — target, verdict + exit code, planner (+ "fell back" and the reason),
    coverage score over N attempts, assertion stats
    (`checkable · verified · refuted`), healing `succeeded/attempted`.
  - *Coverage gate* — every rule with severity, pass/fail, detail, and the gap's
    **hint or suggested flow** — literally what the planner would be handed on a replan.
  - *Stage timeline* — trace events grouped by stage in pipeline order, with warn/error
    levels highlighted.
  - *Planned flows* — category chip, step count, priority, pages.
  - *Scenarios and triage* — status badge, triage classification, confidence, blocked reason.
  - *Declared unknowns* — the planner's `openQuestions`, uncovered PRD requirements,
    and untested surfaces, in one list. The code comment says it best:
    *"What the planner said it could not determine, rather than resolving it by
    assumption. This is the ambiguity trail, and it is the point."*
- **Vocabulary discipline**: a gate rule *fails*, it does not *regress* —
  `ruleBadge()` borrows the palette but not the wording.

---

## 5. The demo application (`demo-app/`)

A standalone Node HTTP server, **zero dependencies**, no QA runtime
import. It exists so every classification can be demonstrated deterministically.

### Routes
`/` (303→`/login`) · `/login` (GET form, POST auth) · `/dashboard` · `/chat` (GET +
POST, conversational channel) · `/cart` · `/checkout` (GET form, POST with
empty-card 400 validation) · `/confirmation` · `/orders/current` (+ DELETE) ·
`/orders/history` (empty state) · `/reference/approved-confirmation` (the design
baseline as a served page) · `/spa-shell` (client-rendered degraded-crawl target) ·
`/__demo/reset` · `/reset`.

Everything after `/login` is gated on **either** the in-memory `state.loggedIn` flag
**or** a `qa-demo-session` cookie (`HttpOnly; SameSite=Lax`), added in PR #3 so a
fetch cookie jar (the crawler) and a Playwright browser context both see
authenticated pages across requests. That is what makes the `authenticated`
precondition real for multi-request agents rather than only for a single process.

The login and checkout inputs deliberately carry **no `required` attribute**: a
native browser validation bubble is unobservable to a semantic executor, so the
behaviour under test is the server-side 400 plus its visible error message. The
comment in the source says so, to stop a future contributor "fixing" it.

### The scenario switch
`POST /__demo/reset` with `scenario=<name>` flips in-memory state **without
restarting**:

| Scenario | Variant | Visible change | Expected classification |
| --- | --- | --- | --- |
| `pass` | `stable` | Approved flow, with no design declaration | `passed`; no design judgement (D1) |
| `drift` | `drift` | "Proceed to checkout" becomes a collapsed `<details>` → "Continue to payment" (same href) | `healed` |
| `missing-target` | `missing-target` | Checkout action removed; no equivalent target exists | `functional_regression` (H2) |
| `functional` | `broken` | Confirmation renders "Order could not be completed" | `functional_regression` |
| `fixture` | `fixture-postcondition` | Login submits but never reaches its declared dashboard postcondition | `functional_regression` (H4) |
| `drift-functional` | `drift-broken` | Checkout drift heals, then confirmation fails | `functional_regression`; later failure wins (H7) |
| `design` | `design` | Confirmation is functionally identical but heading/link order reversed and restyled as a red banner | `design_regression` |
| `cleanup` | `cleanup-broken` | Test order cannot be removed by the after fixture | primary `passed`; cleanup issue retained (E5) |
| `locator` | `locator-drift` | `data-testid` attributes removed | triage `broken_locator` |

`demo-app/reset.js` is an **app-development utility, not part of the skill runtime**:
it accepts only loopback HTTP targets and mutates only the demo process's in-memory
state — it cannot target staging or production. `npm run reset -- --list` prints
the mutations, corner IDs, and expected outcomes.

### Verified agent-driven run (2026-09-05, real Chromium)

| Scenario | What the agent observed | Verdict | Corner case |
| --- | --- | --- | --- |
| `stable` | Full login → cart → checkout → confirm → cleanup | `passed` | — |
| `drift` | Control moved into a collapsed menu and renamed, same destination | `healed` — explicit equivalent target, one retry, expectations verified unchanged | H1 |
| `functional` | Checkout submits, confirmation shows an error | `functional_regression` — refused to rewrite or re-assert a business outcome | H3 |
| `design` | Functionally identical, order reversed, red banner | `design_regression` with structured order/grouping/style findings; functional verdict untouched | D4 |

The additional H2/H4/H7/E5 states are integration-tested with the deterministic
native executor in `test/demo-corner-scenarios.test.js`. Run
`npm run demo:corners` for the complete 28-case drill; this does not overstate
those additions as separately agent-driven Chromium observations.

---

## 6. Demo assets shipped in the repository

`artifacts/live-demo/` — 4:02 MP4, separate neural voiceover (MP3), WebVTT captions,
frame-accurate `timing.json`, `chapters.json`, contact sheet, VHS `.tape` terminal
recordings, `generate-voiceover.mjs` (Edge neural voice `en-US-BrianMultilingualNeural`,
overridable via `AUTO_QA_DEMO_VOICE`), and the reproducible `render-live-demo.mjs`.
The renderer uses measured decoded narration durations, rounds chapters to 30 fps
boundaries, and **rejects audio/video end drift above 12 ms**.

`artifacts/demo-video/` — a second full walkthrough with 14 keyframes, a recording
server, a timing manifest and a playback contact sheet.

`demo.md` — the current judge runbook, aligned to the official scoring weights,
integrated Console, visible disposable demo credentials, and named timing
recoveries. `LIVE_DEMO.md` preserves the shot timing for the existing recording.

`docs/ORCHESTRATOR_DEMO.md` — the tighter 5-minute orchestration demo:
0:00 one input → 0:45 the gate decides → 1:45 validation → 2:30 **it adapts without
failing** → 3:30 **it refuses to lie** → 4:15 the report → 4:45 trade-offs.

The Sep 5 rehearsal ran pass → drift → functional → design against real Chromium.
Every beat completed at 3/7 clean with four `app_defect` reds and exit 10. The pass
variant has no injected shop defect, so those four are demonstrably false-reds and
the aggregate result does not distinguish the variants. The stage script therefore
uses the resets to show application surfaces, not to claim classification fidelity.
It says plainly that three or four reds are harness proof failures, and that exit 10
means a completed red verdict rather than a crash.

> That edit is itself a good slide: the demo script was corrected to stop claiming
> something the implementation had not yet earned.
