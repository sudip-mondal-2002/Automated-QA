import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildDesignComparisonRequest,
  DEFAULT_DESIGN_VIEWPORT,
  designConfigurationForSpec,
  normalizeDesignComparison,
  QaError,
  resolveDesignReference,
} from "../src/index.js";
import { passingResult, temporaryWorkspace } from "../test-support/helpers.js";

test("Phase 4 design helpers cover default checkpoints, remote references, and conservative fallbacks", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const defaultConfiguration = designConfigurationForSpec(
    { reference: "https://figma.com/design/approved" },
    3,
  );
  assert.deepEqual(defaultConfiguration, {
    reference: "https://figma.com/design/approved",
    viewport: DEFAULT_DESIGN_VIEWPORT,
    afterStep: 3,
  });

  const configured = designConfigurationForSpec({
    reference: "https://design.example/approved.png",
    viewport: { width: 1024, height: 768 },
    afterStep: 2,
  }, 3);
  assert.deepEqual(configured.viewport, { width: 1024, height: 768 });
  assert.equal(configured.afterStep, 2);

  const request = buildDesignComparisonRequest({
    reference: { kind: "url", source: configured.reference },
    actual: { path: "screenshots/actual.png" },
    viewport: configured.viewport,
    afterStep: configured.afterStep,
  });
  assert.equal(Object.hasOwn(request.reference, "image"), false);
  assert.notEqual(request.viewport, configured.viewport);

  const exactFigmaHost = await resolveDesignReference("https://figma.com/design/approved");
  assert.equal(exactFigmaHost.kind, "figma");
  const fileReference = await resolveDesignReference(pathToFileURL(workspace.specPath("checkout-card")).href, {
    repositoryRoot: root,
  }).catch((error) => error);
  assert(fileReference instanceof QaError);
  assert.equal(fileReference.code, "UNSUPPORTED_DESIGN_REFERENCE");

  assert.deepEqual(normalizeDesignComparison({ status: "matched" }), {
    status: "matched",
    explanation: "The rendered state matches the explicit design reference",
    findings: [],
  });
  assert.deepEqual(normalizeDesignComparison({
    status: "regression",
    findings: [{ category: "components", status: "regression", explanation: "Primary action is absent" }],
  }), {
    status: "regression",
    explanation: "The rendered state has a reference-backed design regression",
    findings: [{ category: "components", status: "regression", explanation: "Primary action is absent" }],
  });
  assert.deepEqual(normalizeDesignComparison({
    status: "blocked",
    findings: [{ category: "content", status: "not_checked", explanation: "Reference could not be opened" }],
  }), {
    status: "blocked",
    explanation: "Design comparison was blocked",
    findings: [{ category: "content", status: "not_checked", explanation: "Reference could not be opened" }],
  });

  for (const finding of [
    null,
    {},
    { category: "layout", status: "unknown", explanation: "Invalid status" },
    { category: "layout", status: "matched", explanation: 42 },
    { category: "layout", status: "matched", explanation: "   " },
  ]) {
    assert.match(
      normalizeDesignComparison({ status: "matched", findings: [finding] }).explanation,
      /invalid finding/,
    );
  }
});

test("Phase 4 result history filters, sorts, prunes, and repairs pointers without crossing environments", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const results = [
    passingResult({
      runId: "run_20260830_130000_staging",
      environment: "staging",
      startedAt: "2026-08-30T13:00:00.000Z",
      completedAt: "2026-08-30T13:00:01.000Z",
    }),
    passingResult({
      runId: "run_20260830_140000_alpha",
      startedAt: "2026-08-30T14:00:00.000Z",
      completedAt: "2026-08-30T14:00:01.000Z",
    }),
    passingResult({
      runId: "run_20260830_140000_beta",
      startedAt: "2026-08-30T14:00:00.000Z",
      completedAt: "2026-08-30T14:00:01.000Z",
    }),
    passingResult({
      runId: "run_20260830_120000_selected",
      startedAt: "2026-08-30T12:00:00.000Z",
      completedAt: "2026-08-30T12:00:01.000Z",
    }),
  ];
  for (const result of results) await workspace.saveResult(result);

  assert.deepEqual((await workspace.listResults({ limit: 2 })).map((result) => result.runId), [
    "run_20260830_140000_beta",
    "run_20260830_140000_alpha",
  ]);
  assert.deepEqual((await workspace.listRecentResults()).map((result) => result.runId), [
    "run_20260830_140000_beta",
    "run_20260830_140000_alpha",
    "run_20260830_130000_staging",
    "run_20260830_120000_selected",
  ]);
  await assert.rejects(
    () => workspace.listResults({ specId: "../checkout-card" }),
    (error) => error instanceof QaError && error.code === "INVALID_ID",
  );

  assert.deepEqual(await workspace.pruneResults(
    "checkout-card",
    1,
    "run_20260830_120000_selected",
  ), [
    "run_20260830_140000_beta",
    "run_20260830_140000_alpha",
    "run_20260830_130000_staging",
  ]);
  assert.equal((await workspace.readLastTest()).lastRunId, "run_20260830_120000_selected");

  await workspace.saveResult(results[0]);
  await workspace.saveResult(results[3]);
  await workspace.deleteResult("run_20260830_120000_selected");
  assert.deepEqual(await workspace.readLastTest(), {
    specId: "checkout-card",
    environment: "local",
  });
  assert.deepEqual((await workspace.listResults()).map((result) => result.runId), [
    "run_20260830_130000_staging",
  ]);
});
