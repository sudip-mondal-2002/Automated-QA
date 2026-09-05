# Autonomous QA

Autonomous QA is a self-contained Codex skill that turns a product journey into selector-free semantic tests, drives the real UI through native Browser/Chrome or computer use, and saves inspectable evidence without negotiating away correctness.

The developer experience is deliberately small: **install one skill, open the application repository, and describe what to test**. The skill owns setup, runtime commands, application reachability, native UI execution, evidence persistence, reruns, and the optional local results UI.

## Install once

In Codex, install the skill directly from this repository:

```text
$skill-installer Install https://github.com/sudip-mondal-2002/auto-qa/tree/main/.agents/skills/autonomous-qa
```

The skill is available on the next turn. It contains its own bundled runtime, dependencies, schemas, and UI assets. Your application does **not** add an `autonomous-qa` dependency, npm script, service, or database.

## Use it from the application project

Open the app repository in Codex and ask for the outcome you want:

```text
$autonomous-qa Set up QA for this app and verify that a logged-in customer can complete checkout. Keep the order confirmation visible as the required outcome, save screenshots, and show me the evidence.
```

That single request makes the skill:

1. inspect the app's existing development command and local URL;
2. create a project-specific `.qa/` workspace without demo/sample tests;
3. write and validate semantic specs and reusable fixtures;
4. start or reuse the app safely on loopback;
5. reuse a validated adjacent Playwright replay when possible, otherwise drive the journey through native Browser/Chrome or computer use;
6. preserve the original expectations during any healing attempt;
7. save the result and screenshots under `.qa/runs/`;
8. open the packaged loopback results UI when evidence should be reviewed.

For the next iteration, keep talking to the skill rather than operating a runner:

```text
$autonomous-qa Rerun the last test and keep every expectation unchanged.
```

```text
$autonomous-qa Run checkout-design and compare its declared checkpoint with the approved reference.
```

The developer stays in the application project. The internal `qa-agent` launcher is a skill implementation detail, not part of the day-to-day workflow.

## Recorded developer demo

[![Watch the one-skill developer demo](artifacts/live-demo/contact-sheet.png)](artifacts/live-demo/auto-qa-live-demo.mp4)

[Watch or download the demo (4:02)](artifacts/live-demo/auto-qa-live-demo.mp4). It uses conversational neural narration and shows the supported install path, a clean standalone app project with no QA dependency, one natural-language QA request, native UI execution, evidence review, conservative healing, a real functional failure that stays failed, and explicit-reference design regression detection.

Use [LIVE_DEMO.md](LIVE_DEMO.md) to present the same flow live. The repository also includes [captions](artifacts/live-demo/auto-qa-live-demo.vtt), the [voiceover](artifacts/live-demo/auto-qa-live-demo-voiceover.mp3), a frame-accurate [timing manifest](artifacts/live-demo/timing.json), a [contact sheet](artifacts/live-demo/contact-sheet.png), and the reproducible [renderer](artifacts/live-demo/render-live-demo.mjs).

## What is implemented

All five phases in [phases.md](phases.md) are complete.

| Phase | Current implementation |
| --- | --- |
| Foundation | JSON Schema contracts, path-based validation, guarded IDs and paths, atomic file-backed writes, environments, fixtures, specs, results, and last-test selection. |
| Native execution | Web and desktop executor contracts, project-local startup/reuse, semantic fixture and step execution, observations, screenshots, cleanup, and explicit blocked results when native capability is missing. |
| Conservative self-healing | One retry for an explicitly equivalent accessible target, unchanged-expectation verification, before/after evidence, and refusal to heal business outcomes. |
| Design intelligence | Explicit local/remote/Figma references, declared viewport/checkpoint, actual/reference provenance, structured layout/style findings, and a separate design classification. |
| UI and demo | Packaged loopback workspace, editable validated YAML, polling results, screenshot inspection, safe run deletion, prompt-based reruns, a standalone deterministic demo app, and synchronized demo media. |

The installed skill is now a portable package:

```text
.agents/skills/autonomous-qa/
├── SKILL.md
├── runtime/
│   ├── qa-agent.mjs         # bundled runtime, including Playwright
│   └── playwright-core/     # package/browser metadata only
├── schemas/
├── scripts/
│   ├── qa-agent
│   └── qa-agent.mjs
└── ui/
```

It does not import `src/` or `node_modules/` from this development repository. Automated coverage copies the skill to a separate directory, invokes it from an external CommonJS app project whose path contains spaces, performs setup and a native-executor run, saves evidence, serves the packaged UI, and confirms the app's `package.json` remains untouched.

## Correctness contract

Semantic specs store intent and observable outcomes—not CSS selectors, XPath, DOM paths, coordinates, fixed delays, or browser-specific scripts.

```yaml
version: 1
id: checkout-card
title: Customer completes checkout
environment: local

fixtures:
  before:
    - login-customer
  after:
    - cleanup-test-order

steps:
  - intent: Open the shopping cart
    expect:
      - Cart contains one item

  - intent: Proceed to checkout
    expect:
      - Checkout form is visible

  - intent: Submit the approved test payment details
    expect:
      - Order confirmation is visible
      - No error message is shown
```

The result taxonomy is intentionally strict:

| Classification | Meaning |
| --- | --- |
| `passed` | Every declared expectation passed without recovery. |
| `healed` | Interaction mechanics drifted, one equivalent retry worked, and the original expectations passed unchanged. |
| `functional_regression` | An action or required visible outcome failed. The expectation is not rewritten. |
| `design_regression` | Functionality passed, but an explicit reference and actual screenshot support concrete design findings. |
| `blocked` | The environment, fixture, credential, native capability, or declared comparison could not proceed reliably. |

Healing may rediscover a moved or renamed control, open a newly introduced menu, or wait for observable readiness. It may not change expected copy, business outcomes, success/error states, accessibility requirements, fixture postconditions, or design baselines. Uncertainty never becomes a pass.

## File-backed evidence

The skill creates these files in the application repository:

```text
.qa/
├── environments.yaml
├── fixtures/
├── specs/
│   ├── <id>.yaml
│   ├── <id>.playwright.mjs
│   └── <id>.playwright.json
├── last-test.json
└── runs/
    └── <run-id>/
        ├── result.json
        └── screenshots/
```

These are ordinary reviewable project files. Credential inputs stay as environment references such as `${QA_CUSTOMER_PASSWORD}` and resolved values must never appear in YAML, terminal output, results, or screenshots. The most recent 20 results per spec are retained.

## What happens with the two UIs

There are two browser surfaces, but the developer does not operate two platforms:

- **The application UI** is the system under test. The skill starts or reuses its existing local development command. Trusted reruns use the bundled Playwright runtime and an installed Chrome-family browser; missing, stale, unavailable, or failed replays fall back to the native UI capability once.
- **The QA workspace UI** is a loopback-only view over `.qa/`. The skill starts it when evidence should be inspected. It edits the same validated YAML, polls for completed results, and displays observations, selected accessible targets, healing notes, design findings, and declared screenshots.

The workspace UI does not execute tests, schedule jobs, maintain a second copy of state, or expose a remote service. Its copy buttons produce `$autonomous-qa` prompts, so reruns return to the skill rather than leaking internal shell commands. See [scripts.md](scripts.md) for exact lifecycle and persistence behavior.

## Standalone demo project

[`demo-app/`](demo-app/) is a standalone Node project with no dependency on the QA runtime. It provides deterministic pass, interaction-drift, functional-failure, and design-failure states.

When developing only the demo app:

```bash
cd demo-app
npm run dev
```

Its reset helper is an app-development utility, not part of the skill runtime:

```bash
npm run reset -- pass
npm run reset -- drift
npm run reset -- functional
npm run reset -- design
```

The helper accepts only loopback HTTP targets and changes only the demo process's in-memory state. The live demo asks the installed skill to manage QA from this project; it never asks the presenter to clone or operate the QA implementation repository.

## Architecture

```mermaid
flowchart LR
    DEV["Developer in app repo"] -->|"$autonomous-qa request"| SKILL["Installed autonomous-QA skill"]
    SKILL --> REPLAY["Trusted Playwright replay"]
    REPLAY --> TARGET["Application under test"]
    SKILL -->|"fallback / semantic checkpoint"| APP["Native Browser / Chrome / computer use"]
    APP --> TARGET["Application under test"]
    SKILL <--> FILES[".qa semantic specs + evidence"]
    FILES <--> UI["Packaged loopback reviewer"]

    classDef dev fill:#DBEAFE,stroke:#2563EB,color:#172033;
    classDef skill fill:#EDE9FE,stroke:#7C3AED,color:#172033;
    classDef native fill:#FFEDD5,stroke:#EA580C,color:#172033;
    classDef files fill:#DCFCE7,stroke:#16A34A,color:#172033;
    classDef ui fill:#CFFAFE,stroke:#0891B2,color:#172033;
    class DEV dev;
    class SKILL skill;
    class APP,TARGET native;
    class FILES files;
    class UI ui;
```

## Autonomous orchestration (hackathon track)

Beyond the skill above, the repo ships an end-to-end test orchestrator for the
Bessemer Tech Catalyst challenge. One command, URL as the only required input:

```bash
node .agents/skills/autonomous-qa/scripts/qa-agent orchestrate \
  --url http://127.0.0.1:4555 \
  --username demo --password demo \
  --prompt "focus on checkout and authentication" \
  --prd docs/prd.md
```

The pipeline runs with zero human input between stages: probe → fetch-only
crawl + test-plan synthesis → coverage gate (pass / replan / escalate) →
Playwright spec generation with live selector validation → semantic execution
→ locator-chain healing with bug-vs-broken triage → `report.json`/`report.md`
with PRD-gap analysis. Every decision lands in `trace.jsonl`, viewable via
`GET /api/orchestrations/:id/trace` on the loopback UI. See
[docs/architecture.md](docs/architecture.md) and
[docs/ORCHESTRATOR_DEMO.md](docs/ORCHESTRATOR_DEMO.md).

Two honest notes: (a) a missing installed Chrome/Edge browser causes a single
agent fallback rather than a browser download or application dependency
change; (b) semantic YAML remains the contract, while a validated adjacent
Playwright script is the canonical fast-rerun artifact.

## Repository development

The commands below are for maintainers of the skill package, not application developers:

```bash
npm install
npm run build:skill
npm test
npm run test:coverage
npm run test:soak
npm run benchmark:replay
```

`build:skill` bundles production runtime dependencies and copies authoritative schemas/UI assets into the installable skill. Tests rebuild it automatically. Coverage gates enforce 100% production line coverage, at least 95% branch coverage, and at least 98% function coverage.

For internal diagnostics, maintainers can invoke `.agents/skills/autonomous-qa/scripts/qa-agent`, including `replay status <spec-id>` and `replay validate <spec-id>`. A bare shell run can complete only through a trusted replay; if replay is unavailable and no host-native executor exists, it saves `blocked`.

## Scope boundaries

The project intentionally excludes Stagehand, coordinate scripts, fixed sleeps, scheduling, production testing, databases, remote UI hosting, multi-user auth, automatic baseline updates, and pixel-perfect visual diffing. The installed skill bundles its own Playwright runtime but never changes the tested application's dependencies or downloads browsers; it launches an existing Chrome or Edge channel headlessly. Generated replays are constrained, import-free artifacts and are trusted only after three zero-retry fresh-context validations.

The product promise stays narrow: **install one skill, describe intent in the application project, survive harmless UI drift, and keep real functional or design regressions visible.**

## References

- [OpenAI Codex skills](https://developers.openai.com/codex/skills)
- [OpenAI Codex](https://developers.openai.com/codex/)
