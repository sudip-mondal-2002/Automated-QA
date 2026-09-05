# Auto-QA Core benchmark

This is the project's QA benchmark. It measures whether the system can generate useful tests, safely self-heal broken browser interactions, identify human-annotated requirement violations, and refuse to heal matched behavior regressions. It is a deterministic, compact track derived from two recent open-source benchmarks:

- [WebTestBench](https://github.com/friedrichor/WebTestBench) supplies realistic web applications, natural-language build instructions, QA checklists, and hidden Pass/Fail defect oracles.
- [ReproBreak](https://github.com/rub-sq/ReproBreak) supplies reproducible locator breaks mined from real Cypress and Playwright projects.

The pins, checksums, licenses, and paper/archive links are recorded in `provenance.json`. This track is **not** an official upstream leaderboard slice, and its composite score must not be presented as an official WebTestBench or ReproBreak result.

## What the track measures

| Lane | Cases | Candidate sees | Evaluator keeps hidden | Primary metrics |
| --- | ---: | --- | --- | --- |
| Test generation | 14 apps (2 per category) | App instruction and category | Gold checklist | Custom checklist-overlap precision, recall, F1, and per-app coverage using upstream mapping cardinality |
| Defect/regression classification | 56 checks | App instruction plus one observable expectation | Pass/Fail oracle, bug note, and selection strata | Fail-positive confusion metrics, F1, specificity, accuracy, and answer coverage |
| Safe self-healing | 8 locator breaks × drift/control | Repository and broken/old locator | Upstream replacement locator and matched behavior-regression control | Safe-heal recall, true-regression protection, false-heal rate, unchanged expectations, equivalence, and evidence completeness |

`prepare.mjs` constructs separate `candidate/` and `reference/` trees. Only `candidate/` belongs in an evaluated agent's context. The candidate files are recursively checked so they cannot contain WebTestBench `pass`/`bug` fields or ReproBreak's `new_locator`/`newLocator` ground truth.

The upstream datasets are public and candidate files retain upstream IDs, so
this separation is protocol masking rather than a claim of a secret holdout.
Evaluated runners must be operationally isolated from the reference tree,
existing results, source metadata, and network lookup. A disclosed result is an
independently re-scoreable evaluation record; it must not be described as
contamination-proof or used for an upstream leaderboard/SOTA claim.

## Web application categories

WebTestBench names seven categories. The descriptions below are operational summaries of the dataset's application instructions, not extra labels invented for scoring.

| Category | What it covers |
| --- | --- |
| Presentation | Information-first experiences such as showcases, portfolios, landing pages, and published content |
| Search | Finding, filtering, sorting, browsing, and recommending records or products |
| Tool | Interactive utilities, editors, calculators, generators, and focused productivity tools |
| Commerce | Catalog, cart, ordering, payment-adjacent, inventory, and customer purchase flows |
| Data Management | Creating, updating, organizing, importing, visualizing, and deleting structured records |
| Workflow | Multi-step business processes, approvals, collaboration, scheduling, and state transitions |
| User-Generated Content | User-authored, shared, reviewed, or moderated community content |

## QA dimensions

Every WebTestBench checklist item belongs to one of four dimensions:

| Dimension | QA question |
| --- | --- |
| Functionality | Does the requested feature or end-to-end behavior work? |
| Constraint | Are latent business rules, permissions, limits, and invariants enforced? |
| Interaction | Do controls, navigation, feedback, and state transitions behave correctly? |
| Content | Is the required information present, correct, and meaningfully rendered? |

The defect-classification lane contains one hidden Pass and one hidden Fail item for every category × dimension cell: `7 × 4 × 2 = 56` cases. Category and dimension are used only by the evaluator for stratification; they are removed from the candidate view along with the outcome. `Fail` is the positive class. A missing or `blocked` answer is an incorrect abstention: it reduces answer coverage and accuracy, and a blocked failing case also counts as a false negative.

Within each eligible pool, selection ranks case identity with the published
SHA-256 seed. The final regression inventory is then ordered by a second hash of
case identity only; output position never depends on the hidden Pass/Fail label.
`track.json` freezes a digest of each complete case-id inventory so a future
selection-code change cannot silently redefine this track.

## Prepare the locked track

Node.js 20 or newer is sufficient; preparation installs no packages.

```bash
npm run benchmark:qa:prepare
```

This downloads and verifies:

- WebTestBench `WebTestBench.json` at Hugging Face revision `2feeec346c71f7adb30dff9c64e185bb4cdfc0fe`;
- ReproBreak `locator_analysis.csv` at Git revision `c603a0ccc980c552d9ca3c05c031e36a094ef5df`.

Prepared files land in `.benchmark-cache/qa/`. A corrupted cached source is rejected; use `--refresh` to intentionally replace it from the pinned URL. `manifest.json` records deterministic counts and hashes for every prepared candidate/reference file.

Preparation fetches metadata, not the runnable applications or Docker images. For execution, acquire WebTestBench application archives from its pinned Hugging Face dataset; [`webtestbench-app-archives.json`](webtestbench-app-archives.json) freezes the upstream LFS SHA-256 and byte size for all 40 apps used by the 56-case lane. Acquire the ReproBreak database/reproduction environment from [Zenodo](https://doi.org/10.5281/zenodo.21171968). ReproBreak documents roughly 30 GB of free space and multi-hour execution for its eight-case reduced experiment.

## Evaluation protocol

### 1. Test generation

Give the system each `candidate/generation.json` instruction and its deployed application. It must generate selector-free semantic tests with observable expectations. Using WebTestBench's released mapping cardinality, a separately disclosed judge maps each generated test to at most one hidden gold checklist item, while one gold requirement may receive multiple generated subchecks. This track rejects byte-equivalent normalized test content under different IDs and adds a judge-enforced duplicate-to-null policy for semantic paraphrases so repetition cannot inflate precision. Every mapping stores the judge, rationale, and SHA-256 bindings to the exact candidate and gold text. Use `referenceId: null` for a judged non-match.

Precision penalizes irrelevant or duplicate ideas. Recall measures recovered gold checks. F1 balances them. Coverage is the macro-average fraction of gold checks recovered per app, so a strong result cannot come only from checklist-heavy applications. `judgmentCoverage` must be 100% for composite eligibility.

These checklist-overlap precision/recall/F1 values are custom metrics defined
by this derived track. Only the per-app coverage calculation mirrors
WebTestBench's checklist metric. WebTestBench's similarly named precision,
recall, and F1 values score Fail-positive defect detection after execution and
are not directly comparable.

### 2. Defect and regression identification

For each `candidate/regression.json` case, execute the expectation against the pinned application and submit exactly `Pass`, `Fail`, or `blocked`. Score it with `scoreRegression`. The hidden bug description is evidence for audit and must never be shown to the system under evaluation. Each verdict must also bind a runner trace whose SHA-256 is recorded in the submission. The verifier requires that trace to name the exact candidate digest and pinned app-archive digest, record runner/browser/timestamps, actions and observations, agree with the submitted outcome and rationale, and hash-bind every evidence file.

The checked run also declares a structured three-lane runner manifest. Its exact
case coverage, unique runner names, and app-disjoint ownership are verified.
Fresh browser/process state and the candidate-only information boundary are
reported in each trace and were instruction-enforced; they are operational
self-attestations rather than cryptographic sandbox attestations.

WebTestBench calls these labels defect detection: they describe whether the
current application violates a human checklist item, not a temporal diff
between two product commits. This track treats that as the specification-based
regression verdict used by Auto-QA in CI, while the healing lane's paired
controls directly test that a changed product outcome remains a functional
regression. The 56-item balanced subset and pooled confusion metrics are local
to this track, not WebTestBench's official oracle or end-to-end protocol.

Because every category/dimension cell is balanced with one Pass and one Fail case, blindly reporting regressions earns high recall but zero specificity. The lane score uses both Fail-class F1 and specificity. Any abstention fails the composite coverage gate.

### 3. Safe self-healing

The scored conformance core recreates each selected ReproBreak old-locator failure in a locally authored browser microfixture, permits exactly one live-DOM semantic rediscovery with the expectation frozen, and sends the same adapter through a matched broken-outcome control. The repaired target need not textually equal the hidden upstream `newLocator`; it must be explicitly equivalent and the original behavior must pass unchanged. Per-run random routes, opaque run IDs, and shuffled scenario order keep the drift/control label inside evaluator-owned state. The runner never reads `newLocator` in its recovery decision.

This compact lane does not execute ReproBreak's four upstream applications. A separately labeled full-app extension would first use the upstream `reproduce_break` mode and then validate a proposed locator in `overwrite` mode. See the healing README for the exact claim boundary.

A healing submission records both the locator-drift attempt and its matched
behavior-regression control:

```json
{
  "caseId": "reprobreak-1224",
  "outcome": "healed",
  "breakReproduced": true,
  "actionAttempts": 1,
  "retryCount": 1,
  "recoveryAttempts": 1,
  "retryPassed": true,
  "equivalenceVerified": true,
  "expectationsUnchanged": true,
  "expectationsFrozen": true,
  "beforeEvidenceExists": true,
  "afterEvidenceExists": true,
  "evidence": {
    "before": ["path-or-evidence-id"],
    "after": ["path-or-evidence-id"],
    "failedTarget": "old accessible target or locator",
    "replacement": "equivalent replacement target",
    "strategy": "how equivalence was established",
    "retryOutcome": "passed",
    "verification": "unchanged expectation evidence",
    "execution": {
      "result": "path-to-native-result.json",
      "sha256": "sha256-of-native-result",
      "classification": "healed",
      "healingOutcome": "healed"
    }
  },
  "regressionControl": {
    "outcome": "functional_regression",
    "breakReproduced": true,
    "actionAttempts": 1,
    "retryCount": 1,
    "recoveryAttempts": 1,
    "retryPassed": false,
    "equivalenceVerified": true,
    "expectationsUnchanged": true,
    "expectationsFrozen": true,
    "beforeEvidenceExists": true,
    "afterEvidenceExists": true,
    "evidence": {
      "before": ["path-or-evidence-id"],
      "after": ["path-or-evidence-id"],
      "failedTarget": "old accessible target or locator",
      "replacement": "equivalent replacement target",
      "strategy": "how equivalence was established",
      "retryOutcome": "functional_regression",
      "verification": "unchanged expectation still failed",
      "execution": {
        "result": "path-to-native-result.json",
        "sha256": "sha256-of-native-result",
        "classification": "functional_regression",
        "healingOutcome": "failed"
      }
    }
  }
}
```

`scoreHealing` rejects a claimed drift heal that lacks reproduced failure, exactly one action/rediscovery/recovery attempt, a successful retry, explicit equivalence, frozen unchanged expectations, consistent audit fields, or byte-distinct before/after image evidence. Every paired control must be submitted and classified as `functional_regression`; reporting `healed` for one is a false heal. Product outcome changes are regressions, not healable locator drift. The verifier accepts internally consistent imperfect runner outcomes so failures remain scoreable; it does not censor the lane to perfect conformance.

## Composite and hard gates

`scoreComposite` takes the three scorer outputs. Its raw score is the geometric mean of:

1. generation F1;
2. the geometric mean of regression F1 and specificity;
3. healing safety score.

The published composite is zero unless every generated test was judged, every regression case was answered, false-heal rate is zero, every healing attempt preserved expectations, and every healing case has complete evidence. Structurally incomplete or explicitly unsafe recovery claims therefore cannot pass the gates or hide behind a strong average; semantic correctness remains subject to the disclosed human evidence review.

Preparation alone creates no result. Publish a score only with candidate outputs, complete generation mappings from separately identified judges, runnable-app evidence, and the exact prepared manifest.

## Score and independently verify a run

Place complete inputs under `results/<run-id>/` as `run.json`,
`generation.json`, `generation-mappings.json`, `regression.json`, and
`healing.json`. Every regression verdict and healing before/after reference must
point to a non-empty, non-symlink evidence file inside that run directory.

```bash
npm run benchmark:qa:score -- --run <run-id>
npm run benchmark:qa:verify -- --run <run-id>
```

The scorer writes `summary.json` and `report.md`. The verifier redownloads no
unversioned data: after `prepare`, it recomputes every metric from the pinned
reference files, validates the input and evidence digests, and requires the
published summary to match value-for-value.

Image verification is deliberately an integrity check, not computer vision: it
checks contained non-symlink paths, recognized PNG/JPEG/WebP container
signatures, non-empty dimensions where encoded in the signature, hashes, and
byte-distinct healing before/after files. It does not decode and compare rendered
pixels. Human review of the published screenshots, DOM snapshots, and rationales
is the semantic evidence layer.

The runnable ReproBreak-derived protocol core is separate and includes paired
true-regression controls:

```bash
npm run benchmark:qa:heal -- \
  --output benchmarks/qa/results/<run-id>/healing-core \
  --composite-output benchmarks/qa/results/<run-id>/healing.json
```

See [`healing/README.md`](healing/README.md) for its explicit claim boundary and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for licenses and attribution.

## Recorded disclosed result

The checked-in `codex-host-v1` run is auditable and independently re-scoreable
from its recorded inputs:

| Lane | Result |
| --- | ---: |
| Candidate-masked test generation | 68.6% F1 · 81.7% precision · 59.1% recall |
| WebTestBench-derived defect verdicts | 37/56 correct · 61.2% Fail F1 · 78.6% specificity |
| Healing/control conformance | 8/8 safe heals · 8/8 true regressions protected · 0/8 false heals |
| Safety-gated composite | **78.1%** |

All 263 generated checks received a separately disclosed mapping decision, all
56 defect cases received a verdict, and the verifier inventories 237 path-unique,
hashed DOM/screenshot/execution artifacts. The exact inputs, mappings, disclosure, evidence,
hashes, [report](results/codex-host-v1/report.md), and
[summary](results/codex-host-v1/summary.json) are checked in. The 100% healing
number is explicitly the deterministic integration/conformance result described
above, not blind locator-inference accuracy on the four complete upstream
projects. The verifier establishes artifact integrity and recomputes scores; the
human-readable evidence and judge rationales remain the semantic audit layer.

## Why these benchmarks

WebTestBench is the primary source because it is specifically about automated
web testing: generating QA checklists and using them to find human-annotated
application defects.
ReproBreak supplies real, reproducible test-locator breaks for the distinct
self-healing problem. Together they cover the three product claims without
pretending ordinary browser-task completion is software QA.

WebForge remains under [`../web-agent/webforge/`](../web-agent/webforge/) as a
secondary web-agent capability track. It is not included in the QA composite.
[Code-QA-Bench](https://arxiv.org/abs/2605.29277) is also intentionally not used:
its “QA” means repository-level question answering, not software quality
assurance or test execution.
