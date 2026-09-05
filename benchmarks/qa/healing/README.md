# ReproBreak healing core

This is the self-healing lane of the Auto-QA benchmark pack. It evaluates Auto-QA's conservative recovery boundary against the eight cases in ReproBreak's official reduced experiment: one stale interaction, one explicitly equivalent rediscovery, unchanged expectations, and before/after browser evidence.

The source is [ReproBreak](https://github.com/rub-sq/ReproBreak), the ASE 2026 dataset of 449 reproducible Cypress and Playwright locator breaks. Its archival artifact is [Zenodo 21171968](https://doi.org/10.5281/zenodo.21171968), and the paper is [arXiv:2605.12158](https://arxiv.org/abs/2605.12158). The exact selected database records, source commits, paths, line numbers, and locator strings are frozen in [`cases.json`](./cases.json).

## Claim boundary

This is a **protocol/core track derived from ReproBreak**, not an official reproduction of ReproBreak. It replaces each full upstream application with a deterministic local browser microfixture that preserves the real locator-pair shape and models one locally authored assertion-level slice based on the surrounding upstream test. It therefore measures Auto-QA's healing governance and regression protection cheaply and repeatably; it does not measure locator inference on the four complete projects.

The upstream reduced experiment remains the authoritative full-app check. It runs each of the eight IDs in `fixed` and `reproduce_break` modes inside four Docker environments and is documented as a 2–4 hour, roughly 30 GB workflow. No score from this core track should be presented as an upstream ReproBreak score.

## Coverage

| IDs | Repository | Real change shape | Preserved intent |
|---|---|---|---|
| 1224, 1225 | `ghiscoding/angular-slickgrid` | menu root → nested command-list root | inspect `Sort Descending` and `Remove Filter` commands |
| 616, 619 | `tryghost/koenig` | `page.$` ElementHandle/null → `page.locator` Locator contract | toolbar absent before selection and after selection removal |
| 3316, 3318 | `nasa/openmct` | exact accessible name `OK` → `Ok` | confirm folder deletion and clear Recently Viewed |
| 5609 | `microsoft/playwright` | ARIA `listitem` → `treeitem` | expand a suite and open its annotation test |
| 5620 | `microsoft/playwright` | `.ui-mode-list-item-title` → `.ui-mode-tree-item-title` | select `@smoke` and filter the test tree |

Every positive case has a matched true-regression control whose user-visible product outcome is broken. The browser fixture is neutral: it renders no benchmark variant, expected classification, source locator, repository metadata, or reference replacement. Scenario URLs use cryptographically random per-server tokens whose variant mapping stays inside the fixture server. The upstream `new_locator` is retained only in provenance/audit artifacts. It is never rendered, compared, or used to choose or execute a recovery target.

Rediscovery is deterministic and model-free. It inspects the live DOM and derives an accessible target from the failed target plus the frozen semantic intent and expectation. Equivalence requires a unique semantic match (for example, a uniquely named command in the relevant region or a case-insensitive confirmation control in the open dialog), and recovery executes that derived target exactly once. The matched control goes through the same adapter; a safe system must keep it as `functional_regression` rather than treating an actionable replacement as proof that the product works.

## Run

Node.js 20+ and an installed Chrome-family browser are required. The runner tries Google Chrome, Microsoft Edge, then Playwright's managed Chromium.

```bash
node benchmarks/qa/healing/run.mjs \
  --output artifacts/benchmarks/qa/healing/core-v1
```

When publishing into a QA result directory, add `--composite-output
benchmarks/qa/results/<run-id>/healing.json`. The runner rewrites its internal
`.qa/` references relative to that result directory, so the composite verifier
can bind the submission back to the native run artifacts.

Use `--browser-channel chrome`, `--browser-channel msedge`, or another Playwright Chromium channel to select a browser. Add `--json` to print the complete summary to stdout.

The runner starts a loopback-only fixture server, drives real browser pages through `createNativeWebExecutor`, and sends every scenario through `executeRun`. It does not call a model or make browser requests to the internet.

## Scoring

The gate is intentionally strict:

- valid-heal rate: all 8 drift cases must be `healed`, with a matched control proving the unchanged product expectation is still enforced;
- false-heal rate: 0 of 8 true-regression controls may be `healed`;
- true-regression detection: all 8 controls must be `functional_regression`;
- retry compliance: every scenario must record exactly one original action, one rediscovery, and one recovery attempt;
- expectation protection: rediscovery receives a frozen expectation list, and every saved result must retain it exactly;
- evidence completeness: every scenario must persist distinct full-page healing-before and healing-after screenshots, including the neutral outcome region that makes the attempted state transition visible.

The command exits non-zero unless all 16 scenarios satisfy their expected classification and governance checks.

## Artifacts

The output directory contains:

- `summary.json`: machine-readable metrics and per-scenario audit fields;
- `submission.json`: eight safe-heal records consumable by the composite scorer, each containing its complete matched `regressionControl`, independent before/after evidence, semantic-equivalence audit text, and a SHA-256 binding to each native `result.json`;
- `source-cases.json`: the exact provenance fixture evaluated in that run;
- `report.md`: a compact human-readable result;
- `.qa/specs/`: the immutable semantic specs;
- `.qa/runs/*/result.json`: native Auto-QA results, event journals, classifications, and evidence references;
- `.qa/runs/*/screenshots/`: real before/after and checkpoint browser evidence.

## Provenance verification

`cases.json` records the SHA-256 and MD5 of the official database archive. Its SQL query can be run against `ReproBreak.db` to reproduce the eight source rows. The ID order matches `CURATED_IDS` in upstream `run_reduced_experiment.py` at commit `c603a0ccc980c552d9ca3c05c031e36a094ef5df`.

ReproBreak's artifact is MIT licensed; the retained license notice is in [`LICENSE.reprobreak-MIT`](./LICENSE.reprobreak-MIT). The four mined projects remain under their respective licenses. The browser microfixtures here are original distilled fixtures and do not copy their application code.
