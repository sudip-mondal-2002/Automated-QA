# 09 — Slide-by-slide deck outline

A ready-to-build presentation. Each slide has: a title, the single idea it carries,
the content to put on it, and speaker notes. Roughly 22 content slides — cut the
"Deep dive" block for a 10-minute version.

---

## Act I — The problem and the claim (slides 1–4)

### Slide 1 — Title
**Autonomous QA** · *A URL in, a trustworthy test suite out.*
Sub-line: *"The agent may re-locate. It may never re-assert."*

> Notes: open with the one-liner. It is the whole design in seven words.

---

### Slide 2 — The problem with AI test agents
| The failure mode | What it looks like |
| --- | --- |
| Tests that cannot fail | Assertions generated from a *description* of the outcome, so they never match real page text |
| Tests that heal into lies | An agent "fixes" a failing test by rewriting the expectation |
| Confident nonsense | A design regression declared on taste, with no reference |
| Silent scope loss | A crawl fails to log in, the plan covers the logged-out surface, nothing says so |

> Notes: every one of these is a bug **this codebase actually had and fixed** — say
> so. That is more credible than claiming they were designed away.

---

### Slide 3 — The claim
Two products, one engine:
1. **`orchestrate`** — a URL is the only required input. Probe → crawl → plan → gate
   → generate → run → heal → report. Zero human input between stages.
2. **The one-skill developer experience** — install once, describe a journey in your
   own repo, get selector-free semantic tests driven through a real browser.

Runs standalone via plain `node`. No agent harness required.

---

### Slide 4 — The governing principle
> **The runtime ships rails. The host agent brings judgement.**
> Where judgement is absent, the runtime falls back deterministically — and records
> that it did.

Three facts on the slide:
- Zero LLM calls in the runtime. Zero API keys. Two production dependencies (`ajv`, `yaml`).
- Four capability seats: Planner · Executor · Healer · Design comparator.
- Every artifact records which path was taken (`plan.source.planner`).

---

## Act II — Architecture (slides 5–10)

### Slide 5 — System architecture
Use the mermaid diagram from [03 §1](03-agents-and-subagents.md): host agent on top,
runtime meta-agent in the middle, capability seats and deterministic rails below.

> Notes: the arrow that matters is **seats → rails**, labelled "validated output
> only". A sub-agent produces a proposal; a rail decides whether it is admissible.

---

### Slide 6 — The pipeline
The 8-stage flowchart from [04](04-orchestration-pipeline.md), with the gate's
replan back-edge highlighted.

Annotate with the artifact each stage writes: `site-map.json` → `test-plan.json` →
`gaps.json` → `generated/` → `result.json` → `report.json`, with `trace.jsonl`
running underneath the whole thing.

---

### Slide 7 — Task decomposition
The funnel from [03 §7](03-agents-and-subagents.md):
**1 URL → N pages → M flows → M specs → M×K steps → K×J observations → M
classifications → 1 verdict.**

Below it, the ownership table: which level is deterministic, which is delegated,
and what validates each.

---

### Slide 8 — Sub-agent #1: the Planner
The sequence diagram from [03 §3.1](03-agents-and-subagents.md).

Call out the protocol: brief → draft → **schema review** → one feedback-driven
repair → normalize, or fall back with the reason recorded.

> Notes: emphasise the repair loop. The rejection message the planner gets back is
> the literal ajv issue list — actionable, not "try again".

---

### Slide 9 — The assertion rule (the most important slide in the deck)
Two code blocks side by side:

❌ **What a naive generator produces**
```js
await expect(page.getByText(/Order confirmation is visible/i)).toBeVisible();
// the app never renders those words. This assertion can only ever fail.
```

✅ **What this system produces**
```js
await expect(page.getByText(/Order QA-1001 was placed successfully/i).first())
  .toBeVisible(); // expect: Order confirmation is visible
```
…or, when the observable text is genuinely unknown:
```js
// UNVERIFIED expectation (no predicate from the planner): Order confirmation is visible
```

> Notes: *"An expectation with no predicate is honest. A predicate you made up is
> not."* The gate's `checkable-assertions` rule blocks below 80 % predicate
> coverage. Both planners are held to the same sourcing rule: **the assert value
> must be text the crawler actually saw** — a heading, a button label, a link. The
> deterministic planner reaches 71 % that way and honestly escalates on the rest;
> the missing expectations are pages the fetch-only crawl never reached.

---

### Slide 10 — Sub-agents #2–4: Executor, Healer, Design
Three columns, the contract and the refusal for each:

| | Executor | Healer | Design comparator |
| --- | --- | --- | --- |
| Contract | `act` · `observe` · `screenshot` (+7 optional) | `rediscover` → **explicitly equivalent** target | `compareDesign` → structured findings |
| Refusal | no capability → `blocked` with the reason, never "claims it drove the UI" | not explicitly equivalent → `functional_regression` | no reference-backed finding → `blocked`, never `regression` |
| Rail | status enum enforced (`INVALID_NATIVE_RESPONSE`) | expectation guard, one retry, before/after evidence | category/status/explanation validation + self-consistency checks |

---

## Act III — Correctness (slides 11–15)

### Slide 11 — The five classifications
The taxonomy table from [00 §5](00-system-overview.md), with the guard that enforces
each one in the right-hand column.

> Notes: the guards are the point. Anyone can define five labels; the question is
> what stops a run from claiming the wrong one.

---

### Slide 12 — What healing may and may not do
Two columns.

**May**: rediscover a moved or renamed control · open a newly introduced menu ·
wait on observable readiness.

**May not**: change expected copy · change business outcomes · change success/error
states · change accessibility requirements · change fixture postconditions · change
design baselines.

Under them, the four rails: immutable expectations (asserted 3× per heal) · explicit
equivalence · exactly one retry · before **and** after evidence or downgrade to
`blocked`.

---

### Slide 13 — The storage layer is a second verifier
Fifteen guards in `saveResult()`. Pick five for the slide:
- step intent must match the spec exactly;
- expectations and their order must match **byte-for-byte**;
- a `healed` classification requires a real recovery **and** both screenshots on disk;
- a `design_regression` requires a declared reference **and** a concrete finding **and** no failed step;
- a `passed` run that hides a heal is rejected.

> Notes: *"Even if the execution engine were compromised, a fabricated result cannot
> be persisted."*

---

### Slide 14 — The coverage gate
12 rules · 6 blocking / 6 advisory · weighted score (blocking ×3) · skipped rules
leave numerator **and** denominator.

The two governing principles, verbatim from the code:
1. A rule may only block when it can **name an actionable gap** — otherwise the
   replan loop can never fire.
2. Shape rules are **advisory** — a planner that consolidates eleven shallow flows
   into five real journeys is improving the plan while shifting every ratio.

Plus the oscillation guard: *a replan that does not improve the score escalates.*

**The proof that this is a diagnostic, not a KPI** — same target, same command,
before and after the planner was improved:

| | flows | multi-step | predicates | score | verdict |
| --- | --- | --- | --- | --- | --- |
| before | 11 | 0 | 0 % | **0.95** | pass |
| after | 7 | **4** | **71 %** | **0.70** | escalate |

The plan got better and the score went down, because the new plan stopped claiming
coverage it could not isolate (see slide 21, point 5).

---

### Slide 15 — Live validation, not a validation flag
Before / after, honestly labelled as a fix:

| Before | After |
| --- | --- |
| `assertionValidated: true` hardcoded | Every predicate probed against the live page |
| Locator "validation" = 12-char substring match on raw HTML | Candidate chain probed; unreachable pages leave the verdict **open**, not true |
| — | `url_contains` checked against the **crawled path set** |

Headline number: on the LLM-planner comparison run, 23/23 expectations carried a
predicate, 22 were statically checkable, **18 verified, 4 refuted — and all 4
refuted strings were ones the model had itself listed under `openQuestions`.**

> Notes: this is the strongest single evidence slide. The validation layer caught
> exactly the assertions the model was already unsure about.

---

## Act IV — Evidence and demo (slides 16–19)

### Slide 16 — Everything is a file
The `.qa/` tree. Then the reviewer table from
[06 §6](06-storage-schemas-evidence.md): *what question does each file answer?*

No database. No hidden state. The artifacts a judge reads are the artifacts the
system reads back.

---

### Slide 17 — The decision timeline
Screenshot of the orchestration panel: metadata (planner, fallback reason, coverage,
assertion stats), the gate checklist with hints, the stage timeline, planned flows,
scenario triage, and **Declared unknowns**.

> Notes: point at Declared unknowns. *"What the planner said it could not determine,
> rather than resolving it by assumption. This is the ambiguity trail, and it is the
> point."*

---

### Slide 18 — Four demo scenarios, one unchanged spec
| Scenario | What changes in the app | Verdict |
| --- | --- | --- |
| `pass` | nothing | `passed` |
| `drift` | checkout control moved into a menu and renamed, same destination | **`healed`** |
| `functional` | confirmation shows an error | **`functional_regression`** — refused to heal |
| `design` | same content, order reversed, restyled | **`design_regression`** — functional verdict untouched |

All four verified against real Chromium on 2026-09-05.

> Notes: the spec YAML is byte-identical across all four. That is the demo.

---

### Slide 19 — It refuses to lie
Three refusals, each with the exact behaviour:
1. **No browser capability** → `blocked` with the missing-capability reason. A shell
   run never claims it drove the UI.
2. **No explicitly equivalent target** → `functional_regression`. Similarity is not
   equivalence.
3. **No reference-backed finding** → `blocked`, not `design_regression`. Agent taste
   cannot block a release.

Plus: remote target without `--allow-remote` → hard stop, not a warning.

---

## Act V — Rigour and honesty (slides 20–22)

### Slide 20 — How it verifies itself
The six verification levels ([08 §5](08-testing-and-demos.md)): unit → contract →
integration → packaging → live → governance audit.

Numbers: **192 tests, 191 pass, 0 fail**; 10 schemas; 30+ workspace guards; a
packaging test that installs the skill into an external project whose path contains
spaces and asserts the app's `package.json` is untouched.

One live-only find worth 20 seconds: a bag-of-words observation passed *"Customer
dashboard is visible"* **on the login page** ("customer" from a heading, "dashboard"
from the nav) — caught by screenshot on a real run, fixed by scoring against a
single semantic block. A false *pass* is the worst failure a QA tool can have, and
no unit test found it.

---

### Slide 21 — What we would not claim
Five honest lines — deliver these before anyone asks:
1. **Coverage gates are red.** 96.6 % lines / 82.8 % branches / 95.6 % functions
   against declared 100 / 95 / 98. Functionality first; the sweep was cut.
2. **The crawl is fetch-only.** A client-rendered SPA collapses to one flow and
   escalates. Browser-based crawling via the accessibility tree is the fix, and the
   adapter to do it already exists.
3. **The replan loop is unit-tested but does not fire live** — the current run
   escalates on attempt 1 because its blocking gap is marked not-auto-fixable. A
   live beat needs a target whose blocking gaps are all auto-fixable.
4. **`triage()` is written, tested and drawn but not yet wired** into the report.
5. **We cut a flow rather than fake it.** `unauthenticated-redirect` needs per-spec
   browser contexts; without them it would fail for infrastructure reasons and read
   as a product defect. It is now a declared open question — and it costs us the
   `auth-negative` rule and 0.25 of coverage score. We would rather pay that.

> Notes: point 5 is the one that lands. Most teams would have shipped the flow.

---

### Slide 22 — Roadmap, in priority order
1. Run every generated `.spec.js` under Playwright against a known-good app and
   require it to pass (`TODO` 3.2).
2. Feed **refuted predicates back to the planner** with the real page content once
   execution reaches that page — this both fixes invented success assertions and
   gives the replan demo a genuine trigger (`TODO` 1.8 + 1.2).
3. A model-judged coverage rubric on top of the 12 deterministic rules (`TODO` 2.1).
4. Browser-based crawl through the accessibility tree (`TODO` 1.1).
5. Per-spec browser contexts → session isolation → parallelism (`TODO` 1.5, 2.3).
6. The seeded-defect confusion matrix — precision/recall per classification
   (`TODO` 3.1). *This is the number to put on the next version of this slide.*

---

## Appendix slides (hold in reserve)

| # | Slide | Use when asked |
| --- | --- | --- |
| A1 | The 12 gate rules in full, with thresholds | "How does the gate actually score?" |
| A2 | `plan-draft.schema.json` on one page | "How do you constrain the model?" |
| A3 | The 15 `saveResult` guards | "How do you know it isn't fabricating results?" |
| A4 | Secret-flow diagram | "What about credentials?" |
| A5 | Windows portability: four real bugs | "Does it work outside a Mac?" |
| A6 | Exit-code contract | "How does this fit CI?" — note headless CI is explicitly out of scope |
| A7 | Deterministic vs LLM planner comparison table | "Why bother with a model at all?" |
| A8 | The corner-case matrix (33 cases) | "What edge cases did you consider?" |

### A7 content (have this ready — it is the most-asked question)
Same crawl, same prompt, on `demo-app`:

| planner | flows | steps | multi-step | fills inputs | expectations | with predicate | gate | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deterministic | 11 | 11 | 0 | 0 | 22 | 0 | 0.90 | pass |
| model | 7 | 19 | 6 | 6 | 25 | 25 | 0.50 | escalate |

> The finding that drove the gate rebalance: **the model's plan was better by every
> quality measure and the gate scored it worse**, because the gate was scoring plan
> *shape* rather than whether the suite could actually pass. Six rules were demoted
> to advisory and `checkable-assertions` was added. That is the story of an
> evaluation harness being wrong and being fixed — tell it.
