# WebForge web-agent task-completion benchmark

This secondary maintainer benchmark attaches the April 2026 open-source
[WebForge-Bench](https://github.com/yuandaxia2001/WebForge) to this repository.
It is a **web-agent task-completion benchmark, not a QA benchmark**. It evaluates
whether an agent can complete requested workflows in static websites; it does not
evaluate test generation, self-healing, or regression identification. WebForge
contains 934 browser tasks across seven upstream activity domains and three difficulty
levels. Its sites include realistic noise, stateful interactions, visual reasoning,
and final-state verification.

The domain labels describe the user activity being completed, not software-testing
domains:

| Upstream domain | Activity covered |
| --- | --- |
| `domain_1` — Consumer Transaction/Service | Shop, book, reorder, or complete consumer-service transactions under product, budget, shipping, and checkout constraints. |
| `domain_2` — Content Moderation/Compliance | Review queued cases against policies or document evidence, submit approve/reject decisions, and classify violations. |
| `domain_3` — Enterprise Process/Collaboration | Complete business workflows such as approvals, routing, procurement, and team-capacity decisions. |
| `domain_4` — Info Retrieval/Analysis | Gather information from dashboards, documents, tables, or images; calculate or compare options; and submit a conclusion. |
| `domain_5` — Platform Management/Ops | Operate administrative, inventory, logistics, monitoring, and infrastructure-control interfaces. |
| `domain_6` — Tool Usage | Use domain-specific calculators, planners, or configuration tools to derive and submit an exact result. |
| `domain_7` — Content Creation/Publishing | Edit, schedule, select, or publish content using editorial, analytics, and brand constraints. |

The checked-in track is `operation-code-21-v2`: one non-stochastic operation-code
task for every domain-by-level stratum. Candidates must have a valid start page and no
external HTTP(S) or protocol-relative URL literal in any pinned text asset. That last
rule makes the derived track suitable for reproducible local-native execution; the
upstream corpus includes optional fonts, images, scripts, and links on external hosts.
Selection is deterministic from the pinned task manifest and file tree, and the exact
IDs are frozen in [`track.json`](track.json) before scoring. The track uses exact
confirmation-code scoring and therefore needs no paid LLM judge.

The local server applies a restrictive content security policy for subresources,
connections, and forms as a runtime backstop. It requires a task-specific
`<task-id>.localhost` hostname, so local storage cannot carry across tasks even if the
operating system later reuses an ephemeral port. The runner must remain on the printed
origin: top-level external navigation is prohibited by protocol and is not claimed to
be fully enforced by CSP.

This score is deliberately reported as a fixed 21-task track. It must not be presented
as a score on the full 934-task WebForge leaderboard suite.

## Reproduce

Prepare the pinned tasks and website assets in the ignored cache:

```bash
npm run benchmark:webforge:prepare
```

Preparation verifies the immutable dataset revision and task-manifest checksum. Every
cached regular file is then checked using its Git blob SHA-1 and every LFS file using
its raw SHA-256 plus byte size. A corrupt or partial cache entry is downloaded again;
network and integrity failures are fatal rather than selection signals.

Inspect `.benchmark-cache/webforge/tasks.runner.jsonl` for the task prompts. The file
does not contain ground truth. The scorer stores only SHA-256 hashes of answers after
Unicode NFKC normalization and outer trimming. Matching remains case- and
whitespace-sensitive. The runner must not inspect `answers.sha256.json`.

Serve one task on a task-specific loopback origin:

```bash
npm run benchmark:webforge:serve -- --task <task-id> --port 0
```

Open the exact `WEBFORGE_URL` printed by the server and retain the printed
`WEBFORGE_ORIGIN`. Execute the unchanged prompt with the native Browser/Chrome
capability. Use one attempt, at most 50 browser actions, and do not leave that origin.
Do not inspect site source, browser storage from another case, the upstream ground
truth, scorer hashes, prior published results, or expected-answer hashes while solving.
The recorder refuses to overwrite an existing task result.

Record the final operation code and evidence:

```bash
npm run benchmark:webforge:record -- \
  --run native-chrome-v2 \
  --task <task-id> \
  --answer <operation-code> \
  --actions <count> \
  --elapsed <seconds> \
  --origin <WEBFORGE_ORIGIN> \
  --evidence artifacts/benchmarks/webforge/runs/native-chrome-v2/evidence/<task-id>.png
```

Current-format case records require committed benchmark protocol files and store their
full execution-protocol Git revision plus task origin. Historical version-2 records do
not have those fields and must supply explicit provenance when published.

Score the fixed denominator and generate JSON plus Markdown reports:

```bash
npm run benchmark:webforge:score -- --run native-chrome-v2
```

Evidence must be a non-empty file inside that run's `evidence/` directory. Missing
cases count as incorrect. Reports include difficulty/domain breakdowns, evidence
coverage, action and latency means, and a 95% Wilson interval. Exact source revisions,
checksum, selection rule, and protocol are in [`provenance.json`](provenance.json).

After all 21 cases are present and scored, publish a redacted result plus the final
screenshots into the tracked benchmark directory:

```bash
npm run benchmark:webforge:publish -- \
  --run native-chrome-v2 \
  --agent <runner-name> \
  --model <exact-model-or-not-recorded> \
  --reasoning <setting-or-not-recorded> \
  --runners <count> \
  --split <lane-description> \
  --executor <browser-executor-and-version> \
  --execution-revision <legacy-run-full-commit> \
  --origin-isolation <legacy-run-origin-description>
```

The last two flags are required only for historical version-2 records such as
`native-chrome-v2`; current records carry both values themselves. Publishing refuses
partial runs, existing result directories, and dirty benchmark protocol files. It omits
raw submitted operation codes, but publishes each submission hash and the pinned
expected-hash file so a fresh clone can reproduce every correctness bit and the total.
The summary separately records execution and publisher revisions, runtime, origin
isolation, browser surface, and a SHA-256 for every evidence file.

Anyone with a fresh checkout can independently recompute the published correctness
bits, aggregates, answer-hash commitment, and evidence digests without the ignored
benchmark cache or raw run records:

```bash
npm run benchmark:webforge:verify -- --run native-chrome-v2
```

Publishing unredacted final-state screenshots and expected hashes discloses the track.
Accordingly, `operation-code-21-v2` is retired for blind evaluation. Future blind runs
must freeze a new held-out track and exclude `results/` from every runner context.

## Recorded result

The checked-in `native-chrome-v2` demonstration run recorded **18/21 exact
completions (85.7%) on this frozen WebForge-derived operation-code-only track**:
6/7 observed Level-1 cases, 7/7 observed Level-2 cases, and 5/7 observed Level-3
cases. Final-state screenshot files cover every attempt. Read the
[report](results/native-chrome-v2/report.md) or inspect the [machine-readable
summary](results/native-chrome-v2/summary.json). The separate
[human-reviewed analysis](analyses/native-chrome-v2.md) documents the three misses and
the evidence-audit caveat without making the generated report depend on manual edits.

## Scope and why this benchmark is retained

This track remains useful as a secondary check of the browser-control surface that
Autonomous QA may use during execution. A strong score only supports a claim about
web-task completion on this frozen track. The repository's QA benchmark is separate
because QA quality requires generated test oracles, conservative healing, and accurate
regression verdicts.

[Code-QA-Bench](https://arxiv.org/abs/2605.29277) (May 2026) is a useful
methodological analogy: it pins source state,
generates verified gold answers before questions, and evaluates repository comprehension
under closed-book, code-only, and documented access conditions using an LLM judge on
accuracy, completeness, and specificity. This integration reproduces none of those
controlled deltas and does not use Code-QA-Bench as a baseline. Its released task set and
AST-based stripping pipeline are for Python repository-comprehension agents, so running
it directly would measure the coding model rather than Autonomous QA. This integration
instead applies the reproducibility principle to semantic browser QA through a native UI
surface.

WebForge is Apache-2.0 licensed. The upstream license is preserved in
[`LICENSE.apache-2.0`](LICENSE.apache-2.0); published screenshots are attributed to
the pinned WebForge dataset revision in `provenance.json`.

The upstream runner uses `browser-use` and Playwright. This adapter intentionally does
not add either dependency to Autonomous QA. Browser execution remains at the native
capability boundary described by the installed skill, and benchmark artifacts stay
outside the production runtime and schemas.
