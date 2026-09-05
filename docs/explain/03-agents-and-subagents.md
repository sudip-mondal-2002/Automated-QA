# 03 — Agents, sub-agents and task decomposition

This is the conceptual heart of the system. It answers: *what is the agent, what
are the sub-agents, how is the work decomposed, and what stops any of them from
lying?*

---

## 1. The agentic model in one picture

```mermaid
flowchart TB
  HOST["**Host agent** (Codex / Claude)<br/>owns judgement · owns the browser · owns the conversation"]

  subgraph RUNTIME["**Runtime** — orchestrator.js as meta-agent (rails, no judgement)"]
    direction TB
    STAGES["planStages()<br/>bootstrap → probe → plan → gate → generate → run → heal → report → done<br/>+ the gate's replan back-edge"]
    TRACE[("trace.jsonl<br/>every stage & decision")]
  end

  subgraph SEATS["**Capability seats** — filled by the host, or fallen back"]
    P["🧠 **Planner sub-agent**<br/>brief → plan draft<br/>schema-validated, 2 attempts"]
    E["🖱 **Executor sub-agent**<br/>act · observe · screenshot<br/>NativeExecutor contract"]
    H["🩹 **Healer sub-agent**<br/>rediscover · recover · waitFor<br/>equivalence required"]
    D["🎨 **Design comparator**<br/>compareDesign → findings<br/>reference-backed only"]
  end

  subgraph RAILS["**Deterministic rails** — never delegated"]
    C1["crawl + parseHtml"]
    C2["coverage gate — 12 rules"]
    C3["generator + fetch preflight"]
    C4["expectation guard"]
    C5["schemas + storage + redaction"]
    C6["reporter"]
  end

  HOST -.fills.-> P & E & H & D
  RUNTIME --> SEATS
  RUNTIME --> RAILS
  SEATS -->|"validated output only"| RAILS
  RUNTIME --> TRACE

  classDef host fill:#DBEAFE,stroke:#2563EB,color:#172033;
  classDef seat fill:#EDE9FE,stroke:#7C3AED,color:#172033;
  classDef rail fill:#DCFCE7,stroke:#16A34A,color:#172033;
  classDef rt fill:#FFEDD5,stroke:#EA580C,color:#172033;
  class HOST host; class P,E,H,D seat; class C1,C2,C3,C4,C5,C6 rail; class STAGES,TRACE rt;
```

**The rule that generates the whole design:**
> A sub-agent produces a *proposal*. A rail decides whether the proposal is
> admissible. No proposal becomes state without passing a rail.

---

## 2. The meta-agent — `orchestrator.js`

`orchestrate()` is the coordinator. It is deliberately a **straight-line async
function with one back-edge**, not a scheduler:

```js
export function planStages(state) {
  const order = ["bootstrap","probe","plan","gate","generate","run","heal","report","done"];
  const index = order.indexOf(state.stage);
  if (index === -1) return "bootstrap";
  if (state.stage === "gate" && state.verdict === "replan") return "plan"; // the only cycle
  return order[Math.min(index + 1, order.length - 1)];
}
```

Responsibilities it keeps for itself:
- **Target admission** — `assertTargetAllowed()`: `http`/`https` only, loopback
  unless `--allow-remote`, otherwise `ORCHESTRATION_REMOTE_BLOCKED` (which is
  re-thrown, never converted to an exit code).
- **Identity and location** — `orchestrationId = orch_<epoch-ms>`, artifacts under
  `.qa/runs/orchestrations/<id>/`.
- **Secret seeding** — the tracer is constructed with `[password, username]`
  (length > 3) so *every* trace line is redacted from event #1. (This was a real
  bug: the tracer used to be built with no `sensitiveValues` at all.)
- **Decision journal** — every gate verdict is appended to `decisions[]` with
  `{ seq, stage, decision, reason, at }` and surfaces in `report.md` under
  **"What the agent decided"**.
- **Failure conversion** — `QaError` codes become exit codes; unknown errors re-throw.

What it does **not** do: decide what to test, decide how to click, decide whether a
design differs. Those are seats.

---

## 3. Sub-agent #1 — the Planner (`src/planner-agent.js`)

The only sub-agent with a full negotiation protocol. 266 lines, and the file opens
with an explicit statement of philosophy:

> *"The orchestrator does not talk to a model. It states what it needs, hands that
> brief to whatever planner capability the host provides, and validates whatever
> comes back against `schemas/plan-draft.schema.json` before trusting a word of it."*

### 3.1 The protocol

```mermaid
sequenceDiagram
  autonumber
  participant O as orchestrator
  participant PA as planner-agent.js
  participant Host as Planner sub-agent (host)
  participant V as plan-draft.schema.json
  participant Det as deterministic planner

  O->>PA: planWithAgent({planner, siteMap, prompt, prd})
  alt no capability
    PA->>Det: buildTestPlan()
    PA-->>O: plan.source = {deterministic, fellBack:true, reason:"no planner capability"}
  else capability present
    PA->>PA: buildPlannerBrief() — site map + focus + PRD
    PA->>Host: {brief, instructions, schema, siteMap, prompt, prd}
    Note over O: trace: planner_started (attempt 1)
    Host-->>PA: draft JSON
    PA->>V: reviewDraft(draft)
    alt valid
      PA->>PA: normalizePlan() — ids, dedupe, counts
      PA-->>O: plan.source = {agent, attempts:1}
      Note over O: trace: planner_completed
    else invalid
      Note over O: trace: planner_rejected + reasons
      PA->>Host: retry with feedback = the exact ajv issues
      Host-->>PA: corrected draft
      alt still invalid
        PA->>Det: buildTestPlan()
        PA-->>O: fellBack:true, reason:"rejected after 2 attempt(s): …"
      end
    end
  end
```

**Failure modes all covered:** capability absent, capability throws
(`planner_failed`, fall back with the thrown message), draft invalid twice, draft
with zero flows. The pipeline never stalls and never proceeds on an unvalidated draft.

### 3.2 The brief (`buildPlannerBrief` + `renderSiteMapBrief`)

The planner is not handed raw HTML. It is handed **structure plus observable
strings**, capped at 60,000 characters:

```
TARGET: http://127.0.0.1:4555
CRAWL SESSION: authenticated (protected pages below were fetched signed in)
          ── or ── anonymous (login either was not attempted or did not succeed —
                              treat protected pages with suspicion)
WARNING: the crawl looks degraded (very few links/forms found). The app may render
         client-side… Say so in openQuestions.          ← only when siteMap.degraded

## Crawled pages
### /checkout  (HTTP 200, depth 2)
title: Checkout · QA Shop
headings: h1 "Checkout form"
links: "Dashboard" -> /dashboard, "Cart" -> /cart
form[0]: method=post action="/checkout" buttons=[Place order] inputs=[card:text required]
signals: checkout, payment

## Developer focus (natural language)
focus on checkout and authentication

## Product requirements
- REQ-3: Users complete a purchase with a saved or newly entered card…

Produce the test plan now.
```

Three design choices worth calling out:
- **Provenance is stated, not implied.** "anonymous" vs "authenticated" tells the
  planner whether protected pages can be trusted. (Before this, a silent login
  failure produced a plan of the logged-out surface with nothing saying so.)
- **Degradation is stated.** An SPA shell gets a warning and an instruction to
  record doubt in `openQuestions` rather than claim coverage.
- **Truncation is stated.** Over 60k chars, the brief ends `… (site map truncated)`.

### 3.3 `PLANNER_INSTRUCTIONS` — the sub-agent's system prompt

Exported as a constant so `SKILL.md` and the runtime cannot drift apart. Contents:

- **What makes a good plan**: happy + error + edge (a happy-only plan is a *failed*
  plan); prefer real multi-step journeys over disconnected clicks; every form gets a
  success case and a rejection case; guard destructive/money-moving actions; mark
  session-requiring flows `authenticated`.
- **THE ASSERTION RULE — the most important rule.** Each expectation has `prose`
  (what a human writes) and `assert` (what a browser evaluates).

  > *"NEVER copy the prose into the assert value. 'Order confirmation is visible'
  > is a description, not page text — asserting it would always fail. If the crawl
  > shows the confirmation page has the heading 'Thank you for your order', then
  > the assert value is 'Thank you for your order'."*

  Escape hatches, in order of preference: `url_contains` with the expected path;
  omit the predicate entirely; record it in `openQuestions`.
  > *"An expectation with no predicate is honest; a predicate you made up is not."*
- **Predicate kinds**: `text`, `absent_text`, `url_contains`, `visible`, `absent`, `count`.
- **Inputs**: exact input names from the site map, realistic values, `sensitive: true`
  for passwords and tokens.
- **Scope**: weight toward the developer's focus but keep baseline coverage; map
  `requirementIds` honestly — *"Do not claim coverage you did not plan."*

### 3.4 `reviewDraft` and `normalizePlan`

`reviewDraft` returns `{ ok, reason }`; the reason is the **first 8 ajv issues**
joined as `path: message`, which becomes the literal `feedback` string in the retry
call. Empty `flows` is rejected separately with a plain-English reason.

`normalizePlan` converts draft shape → internal plan shape:
- ids get a `flow_` prefix and are slugified; **collisions are de-duplicated**
  (`flow_checkout` → `flow_checkout-2`) so every flow stays addressable;
- optional step fields (`page`, `action`, `channel`, `inputs`) are included only if
  present; empty `assert` objects are stripped;
- `coverageClaims` counts are recomputed from the actual flows, not trusted from the draft;
- `source: { planner: "agent", fellBack: false, attempts: N }` is stamped.

### 3.5 Deterministic fallback planner (`buildTestPlan`)

The oracle, not the reasoner. Rules-based synthesis from the crawl:

| Trigger in the crawl | Flow synthesized | Category |
| --- | --- | --- |
| Any form | Submit-happy path, titled with the **form's own submit label** ("Place order", not "Submit form on /checkout") | happy |
| Password input present | Sign-in happy path; auth-gate noted honestly when observed off `/login` | happy |
| Password input present | Reject invalid credentials | error (critical) |
| Each required non-password input | Reject empty `<field>` | error |
| Form with inputs but no required ones | Reject invalid submission | error |
| `signals.list` (table / pagination / results) | Show empty state | edge |
| `signals.numeric` (`type=number` / "quantity") | Reject out-of-range quantity | edge |
| `signals.payment` + a form | Guard double submission | edge |
| Any page with no happy flow | `View <path>` smoke | happy |
| Any submittable form page (except `/login` and `/`) with no edge flow | Reject malformed input | edge |

Plus: PRD requirement mapping using only the **first three** (most topical)
keywords of each requirement — a deliberate fix, because matching on any of eight
keywords made REQ-4 "promo codes … at checkout" falsely claim coverage from every
checkout flow via the word "checkout".

#### Journey planning (added in PR #3)
Single-step flows assumed the executor starts on the form page. It does not — it
starts wherever the login fixture left it. So `buildTestPlan` now **BFS-walks the
observed link graph** (max 2 hops) from the landing page (`/dashboard`, else `/`,
else the first page) to each target page, and emits one `Open` step per hop **using
the recorded link text as the intent** — matchable by construction, because the text
came from the crawl. No path found, or a login form, → single-step fallback.

Measured on the demo app: **4 of 7 flows are now multi-step journeys**, e.g.

```
Open shopping cart → Proceed to checkout → Place order
```

#### Predicate emission (added in PR #3)
Two helpers now attach machine-checkable predicates to deterministic expectations:

| Helper | Behaviour |
| --- | --- |
| `textExpect(prose, keywords, pages)` | Searches **crawled headings, button labels and link text** for a string containing all keywords. Hit → `{ prose, assert: { kind: "text", value: <the observed string> } }`. Miss → a bare prose string, which compiles to `// UNVERIFIED` rather than a fabricated assertion. |
| `absentExpect(prose)` | Strips the negation ("No error message is shown" → "error message") and emits `{ prose, assert: { kind: "absent_text", value } }`. |

Example from a live run:
```json
[{ "prose": "Customer dashboard is visible",
   "assert": { "kind": "text", "value": "Customer dashboard" } },
 { "prose": "No error message is shown",
   "assert": { "kind": "absent_text", "value": "error message" } }]
```
The assert value is **text the crawler actually saw**, never prose-derived copy —
the same rule the Planner sub-agent is held to, enforced structurally here.

> **This supersedes an earlier design note.** The deterministic planner used to emit
> prose only, and `checkable-assertions` escalated on it for that reason. It now
> reaches **15/21 = 71 %** predicate coverage on the demo app — still under the
> rule's 80 % threshold, so the gate still escalates, but now because the remaining
> 29 % are honestly-unknown page texts rather than because predicates were absent by
> construction. Higher predicate coverage remains a Planner-sub-agent job.

#### A flow that was deliberately cut
The `unauthenticated-redirect` flow ("open a protected page without signing in") was
**removed**, with this reasoning in the code:

> *"Session-isolation flows need a fresh logged-out browser context per spec.
> Single-context runs cannot isolate sessions, so this flow would fail for
> infrastructure reasons and masquerade as product signal."*

Instead the planner pushes an **open question** into the plan:
`"Session-isolation flows (logged-out deep links) unverified: single-context runs
cannot isolate sessions"`, which survives into `test-plan.json`, `report.json` and
the UI's *Declared unknowns* panel.

Consequence to state honestly: the gate's `auth-negative` rule now **fails**
(it wants both an invalid-credential and an unauthenticated-redirect flow), so a
cold deterministic run on the demo app escalates at **0.7** rather than passing at
0.95. That is the system declining to fake coverage it cannot isolate, and paying
for it in its own score.

---

## 4. Sub-agent #2 — the Executor (`NativeExecutor`)

The contract, not an implementation:

| Method | Required | Contract |
| --- | --- | --- |
| `act(intent, ctx)` | ✅ | Perform the minimum semantic action for the intent. Return `{ selectedTarget?, outputs?, status?, observation? }` |
| `observe(expectation, ctx)` | ✅ | Return `true`/`false`, or `{ status: passed\|failed\|blocked, observation? }` |
| `screenshot(ctx)` | ✅ | Return a Buffer, or `{ data\|path, extension, encoding? }` |
| `isAvailable()` | ○ | Capability self-report |
| `connect(target, ctx)` | ○ | Attach to the prepared environment |
| `rediscover(intent, ctx)` | ○ | Healing: propose an equivalent target |
| `recover(intent, target, ctx)` | ○ | Healing: retry against the replacement |
| `waitFor(expectation, ctx)` | ○ | Healing: observable readiness (never a sleep) |
| `compareDesign(request, ctx)` | ○ | Design sub-agent seat |
| `consoleErrors` / `networkErrors` | ○ | Evidence; absence is declared as `unsupported` |
| `close(ctx)` | ○ | Teardown |

**The context object is the sub-agent's whole world**: `runId`, `scope`
(`fixture`/`test`), `phase`, `stepIndex`, `channel`, `inputs` (resolved fixture
inputs), `outputs` (accumulated cross-step outputs), `target` (resolved
environment), `signal` (AbortSignal), and `previousTarget` — the accessible target
that worked on the last successful run of this exact step, loaded from the previous
result. That last one is genuinely clever: **the executor gets told what used to
work**, which is what makes rediscovery conservative rather than a fresh guess.

Two reference implementations exist:
- `test-support/demo-native-executor.js` — deterministic, used by the suite.
- `src/playwright-executor.js` — dev/demo only, **never bundled**. Still
  heuristic, but PR #3 made the heuristics defensible rather than merely dumb:

  | Behaviour | Why |
  | --- | --- |
  | **Block-scoped observation** — the page is split into semantic blocks (title, `h1–h6`, `p`, `li`, `button`, `a`, `label`, `td`, `th`) and an expectation must match a **single block**, at ≥ 60 % keyword hit rate | A bag-of-words match across the whole page passed *"Customer dashboard is visible"* on the **login page** by taking "customer" from a heading and "dashboard" from the nav — proven by screenshot |
  | **Chain-ordered click** — `getByTestId` → `getByRole` → text, with every attempt recorded in the selected target as `[chain: testid=place-order:miss -> role=Place order]` | Mirrors the generated sidecar's strategy order; when a redesign drops the testid, the fallback leaves a **receipt**, not a mystery |
  | **Fuzzy-match receipt** — a partial keyword overlap annotates the target as `(fuzzy 1/2)` | Drift absorbed is drift *disclosed* |
  | **No auto-navigation on step 1** | Blindly returning to `baseUrl` discarded the state the login fixture had established, so every spec acted on the login form |
  | **Idempotent nav / sign-in** — "Open the shopping cart" when the cart is already displayed, or "Sign in" when the dashboard is showing, reports success instead of clicking again. Negative variants (`invalid\|empty\|blank\|wrong\|bad\|incorrect`) are excluded | Clicking again would resubmit or wander; but a negative test must really submit |
  | **Data-entry intents** (`Enter/Fill/Type/Provide`) fill and stop | Entering a test card must not place the order |
  | **Preserved between-fixture inputs** — values filled by a `between` fixture survive until the submit step; `before`-fixture fills (credentials) are **not** preserved | The session cookie carries auth; stale credentials would corrupt negative tests |

In production the seat is filled by the host agent driving Browser / Chrome /
computer use directly.

---

## 5. Sub-agent #3 — the Healer (`src/healing.js` + the executor's healing methods)

Not a separate process — a **decision machine** that consumes the executor's
proposals. The state machine is `classifyFailure()`:

```mermaid
flowchart TB
  IN["classifyFailure(failure, rediscovery?,<br/>verification?, readinessAvailable, recoveryAttempted)"]
  IN --> G1{"expectations<br/>unchanged?"}
  G1 -->|no| B1["**blocked**<br/>Original expectations changed during recovery"]
  G1 -->|yes| G2{"failure.status"}
  G2 -->|blocked| B2["**blocked**<br/>Execution was blocked before recovery"]
  G2 -->|failed| G3{"verification<br/>supplied?"}

  G3 -->|"passed + recoveryAttempted"| H["**healed**<br/>Original expectations passed unchanged"]
  G3 -->|"passed, no recorded attempt"| B3["**blocked**"]
  G3 -->|blocked| B4["**blocked**"]
  G3 -->|failed| F1["**functional_regression**<br/>Expectations still fail after recovery"]

  G3 -->|"none · stage = expectation"| G4{"waitFor<br/>supported?"}
  G4 -->|yes| W["decision: **wait_for_readiness**"]
  G4 -->|no| F2["**functional_regression**<br/>Expected outcome failed"]

  G3 -->|"none · stage = action"| G5{"rediscovery"}
  G5 -->|"undefined (not tried)"| R["decision: **rediscover_target**"]
  G5 -->|blocked| B5["**blocked**"]
  G5 -->|"found + equivalent===true + target"| RT["decision: **retry_equivalent_target**"]
  G5 -->|anything else| F3["**functional_regression**<br/>No safe equivalent target"]

  classDef ok fill:#DCFCE7,stroke:#16A34A,color:#172033;
  classDef bad fill:#FEE2E2,stroke:#DC2626,color:#172033;
  classDef act fill:#FFEDD5,stroke:#EA580C,color:#172033;
  class H ok; class B1,B2,B3,B4,B5,F1,F2,F3 bad; class W,R,RT act;
```

Rails that cannot be argued with:

1. **`createExpectationGuard(expectations)`** — snapshots `JSON.stringify` of the
   expectation array and freezes a copy. `assertUnchanged()` is called **three
   times** during a heal (before re-observation, after recovery, at the end). Any
   byte or order change throws `EXPECTATION_MUTATED` with the path
   `$.steps[].expect` and the message *"must remain byte-for-byte unchanged during
   healing"*.
2. **`normalizeRediscovery(response)`** — a replacement is only accepted when the
   response is `status: "found"` **and** `equivalent === true` **and** carries a
   target. Everything else degrades to `ambiguous` with an explanation:
   *"The replacement was not explicitly confirmed as equivalent."* Similarity is
   never enough.
3. **One retry, ever.** `attemptHealing` runs once per step. There is no loop.
4. **Evidence or it didn't happen.** If a heal succeeds but either the before or
   after screenshot is missing, the classification is **downgraded to `blocked`**
   with *"Recovery passed but required before/after screenshot evidence is
   unavailable."*
5. **Capability gating.** Rediscovery is only attempted if
   `executor.supports("rediscover")`; readiness waiting only if
   `supports("waitFor")`. No capability → no heal → honest failure.
6. **Fixtures are never healed.** `attemptHealing` is only wired into test steps.

Two strategies exist: `target_rediscovery` (action-stage failures) and
`readiness_wait` (expectation-stage failures). Both end in the same place —
re-observe the **original** expectations and only then classify.

---

## 6. Sub-agent #4 — the Design comparator (`src/design.js`)

The seat with the strictest admission rules, because "the design looks off" is the
easiest place for an agent to hallucinate authority.

- **A comparison only happens when the spec declares one.** No `design` key → no
  design result at all (`UNEXPECTED_DESIGN_RESULT` if one appears anyway).
- **The reference must be explicit and resolvable**: a local image (PNG/JPEG/WebP)
  inside the repository, an `http(s)` URL, or a Figma link (hostname `figma.com` or
  `*.figma.com`). Local paths are `realpath`'d and checked to be inside the
  repository root; `file://` URLs naming a host are rejected on every platform
  (they are UNC paths on Windows and would reach out over SMB).
- **The comparison rules are shipped to the sub-agent** as
  `DESIGN_COMPARISON_RULES`, six lines that scope the judgement:
  presence of required components/content · major layout, order, grouping,
  alignment · only obvious style signals · **ignore** pixel/font-rendering/
  anti-aliasing differences · regression only when the reference *directly supports*
  a concrete finding · **never update or reinterpret the reference to make the
  rendered state pass**.
- **The output is structurally constrained.** `normalizeDesignComparison` rejects
  any finding whose `category` is not one of
  `components|content|layout|order|grouping|alignment|style`, whose `status` is not
  `matched|regression|not_checked`, or whose `explanation` is empty. Then two
  consistency checks:
  - `regression` with **no** regression-status finding → **blocked**
    (*"A design regression requires at least one concrete reference-backed finding"*);
  - `matched` **with** a regression finding → **blocked**
    (*"Design comparison contradicted its own matched decision"*).
- **Functional verdict wins.** A design regression is only ever produced *alongside*
  a passing functional run, never instead of a failing one
  (`DESIGN_REGRESSION_WITH_FAILED_STEP`).

---

## 7. Task decomposition — how one URL becomes N verdicts

```mermaid
flowchart TB
  A["1 URL"] --> B["N pages<br/>(BFS crawl, ≤25 pages, ≤3 depth)"]
  B --> C["M flows<br/>(happy / error / edge, each with ordered steps)"]
  C --> D["M semantic specs<br/>(selector-free YAML in .qa/specs/)"]
  D --> E1["M locator sidecars<br/>(*.locators.json — strategy chains + predicates)"]
  D --> E2["M portable artifacts<br/>(*.spec.js for the developer's own runner)"]
  D --> F["M runs × K steps<br/>(executeRun per spec)"]
  F --> G["K×J expectation observations"]
  G --> H["M classifications"]
  H --> I["1 report<br/>verdict · triage · gaps · PRD diff · exit code"]

  classDef s fill:#DBEAFE,stroke:#2563EB,color:#172033;
  class A,B,C,D,E1,E2,F,G,H,I s;
```

### Decomposition levels and who owns each

| Level | Unit | Produced by | Validated by |
| --- | --- | --- | --- |
| 0 | Target | human / CLI | `assertTargetAllowed` |
| 1 | Page | `crawl()` — deterministic BFS | `site-map.schema.json` |
| 2 | Flow | Planner sub-agent **or** `buildTestPlan()` | `plan-draft.schema.json` → `test-plan.schema.json` |
| 3 | Plan quality | — | **coverage gate**, 12 rules, score, verdict |
| 4 | Spec | `planToSpecs()` (+ `mergeActionSteps`) | `spec.schema.json` + cross-file refs |
| 5 | Locator chain | `bindLocators()` + `selectorCandidates()` | `validateSelectors()` against the live page |
| 6 | Step | `executeSemanticStep()` | executor contract normalization |
| 7 | Expectation | `observeExpectations()` | `STEP_STATUSES` whitelist |
| 8 | Run classification | `executeRun()` | `result.schema.json` + 15 storage guards |
| 9 | Scenario triage | `orchestrator` (inline) / `triage()` (available) | `report.schema.json` |
| 10 | Verdict + exit code | `buildReport()` | `report.schema.json` |

### Two merges that make the decomposition honest

- **`mergeActionSteps()`** — a planner will happily emit *"fill the card field"*
  with no expectation. That is honest (filling a field is observable by nothing) but
  it is not a *semantic* step, and the spec contract requires every step to declare
  what you should see. So an action-only step folds into the next step that asserts
  an outcome, **carrying its inputs**. A pending step on a *different page* is kept
  (it represents a real navigation) and made assertable with
  `Action completes: <intent>`. Trailing action steps get the same treatment.
- **`previousTargetsFor()`** — before a run, the previous result for the same
  spec+environment is loaded and its `selectedTarget`s are indexed by step. Each
  step's context then carries `previousTarget`, so healing compares against what
  actually worked, not against nothing.

---

## 8. Sub-agent lifecycle legibility

Every sub-agent interaction is traceable in `trace.jsonl` and visible in the UI
timeline:

| Event | Emitted when |
| --- | --- |
| `planner_ready` | a planner capability was supplied at bootstrap |
| `planner_started` | brief handed over (with attempt number) |
| `planner_completed` | draft accepted (flows + open-question count + attempt) |
| `planner_rejected` | draft failed validation, with the reasons |
| `planner_failed` | the capability itself threw |
| `page_crawled` | each crawled path |
| `selector_validated` | each binding probed, with resolved strategy |
| `decision` / `replan_triggered` | gate verdicts |
| `healing_started` / `healing_completed` | per healed step (in the run's own event journal) |
| `design_started` / `design_completed` | per declared design checkpoint |
| `*_invalid` (warn) | any artifact that failed its schema before writing |

> This is the answer to *"how do I know the agent did what it says?"* — the agent
> pipeline is legible **in the artifact**, not only in the architecture diagram.

---

## 9. Honest gaps in the agentic story

State these before a judge finds them:

1. **The sub-agents are in-process modules, not separately budgeted agents.** They
   have explicit input/output contracts and lifecycle trace events, but no per-agent
   `{budget, retries, timeout}` envelope. (`TODO.md` §2.2.)
2. **The Gate has no model-judged rubric pass.** It is 12 deterministic rules. The
   planned addition is a "would a senior QA engineer sign this off?" pass whose
   findings become gaps with suggestions. (`TODO.md` §2.1 item 2.)
3. **The Healer's triage seat is not model-filled.** `triage()` exists with a full
   confidence table but is not called from the orchestrator. (`TODO.md` §0.6.)
4. **The replan loop is unit-tested but not observed live.** On the current demo app
   a cold deterministic run escalates on attempt 1, because `checkable-assertions`
   emits a gap marked `autoFixable: false` and `decideVerdict` escalates on any
   unfixable blocking failure rather than burning a replan attempt. The structural
   cause identified earlier (a blocking rule with no gap at all) was fixed; a live
   replan beat now needs a run whose only blocking gaps are auto-fixable.
5. **No run-level budget or timeout.** `executor.act()` is awaited with no deadline;
   `signal` is only checked *between* steps. (`TODO.md` §1.6.)
6. **Session isolation is a declared blind spot, not a solved problem.** The
   unauthenticated-redirect flow was cut rather than faked, and the gap is carried
   in `openQuestions` — but that means `auth-negative` blocks and the honest run
   scores lower than the dishonest one used to.
