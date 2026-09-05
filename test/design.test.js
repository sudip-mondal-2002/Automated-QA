import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDesignComparisonRequest,
  createNativeWebExecutor,
  DEFAULT_DESIGN_VIEWPORT,
  DESIGN_COMPARISON_RULES,
  executeRun,
  normalizeDesignComparison,
  QaError,
  resolveDesignReference,
} from "../src/index.js";
import { createDemoApplication } from "../demo-app/server.js";
import { demoNativeExecutor } from "../test-support/demo-native-executor.js";
import { passingResult, temporaryWorkspace } from "../test-support/helpers.js";

const IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function designSpec(workspace, root, overrides = {}) {
  await writeFile(path.join(root, "approved-confirmation.png"), IMAGE);
  const original = await workspace.loadSpec("checkout-card");
  const spec = {
    ...original,
    id: "design-checkout",
    title: "Checkout matches the approved confirmation design",
    design: {
      reference: "approved-confirmation.png",
      viewport: { width: 1280, height: 900 },
      afterStep: 3,
      ...overrides,
    },
  };
  await workspace.saveSpec(spec);
  return spec;
}

async function pointLocalEnvironmentAt(workspace, baseUrl) {
  const environments = await workspace.loadEnvironments();
  environments.environments.local = { type: "web", baseUrl };
  await workspace.saveEnvironments(environments);
}

async function runDemoDesign(t, variant = "stable", customizeExecutor) {
  const { root, workspace } = await temporaryWorkspace(t);
  await designSpec(workspace, root);
  const demo = createDemoApplication({ variant });
  t.after(() => demo.stop());
  const baseUrl = await demo.start(0);
  await pointLocalEnvironmentAt(workspace, baseUrl);
  const executor = demoNativeExecutor();
  customizeExecutor?.(executor);
  const result = await executeRun({
    workspace,
    specId: "design-checkout",
    executor,
    variables: { QA_CUSTOMER_USERNAME: "customer", QA_CUSTOMER_PASSWORD: "password" },
  });
  return { demo, executor, result, root, workspace };
}

test("design references resolve repository images, URLs, Figma links, and secret indirection", async (t) => {
  const { root } = await temporaryWorkspace(t);
  const imagePath = path.join(root, "approved.png");
  await writeFile(imagePath, IMAGE);

  const image = await resolveDesignReference("approved.png", { repositoryRoot: root });
  assert.equal(image.kind, "image");
  assert.equal(image.source, await realpath(imagePath));
  assert.deepEqual(image.artifact.contents, IMAGE);
  assert.deepEqual(image.sensitiveValues, []);

  const secret = await resolveDesignReference("${QA_DESIGN}", {
    repositoryRoot: root,
    variables: { QA_DESIGN: "approved.png" },
  });
  assert.equal(secret.reference, "${QA_DESIGN}");
  assert.deepEqual(secret.sensitiveValues, ["approved.png"]);

  assert.equal((await resolveDesignReference("https://design.example/reference.png")).kind, "url");
  assert.equal((await resolveDesignReference("https://www.figma.com/design/abc/Checkout")).kind, "figma");
});

test("design reference resolution rejects missing, unsupported, non-string, and escaping files", async (t) => {
  const { root } = await temporaryWorkspace(t);
  await writeFile(path.join(root, "notes.txt"), "not an image");
  await mkdir(path.join(root, "folder.png"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "auto-qa-design-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideImage = path.join(outside, "outside.png");
  await writeFile(outsideImage, IMAGE);

  const cases = [
    ["missing.png", {}, "DESIGN_REFERENCE_NOT_FOUND"],
    ["notes.txt", {}, "UNSUPPORTED_DESIGN_REFERENCE"],
    ["folder.png", {}, "DESIGN_REFERENCE_NOT_FOUND"],
    ["http://", {}, "INVALID_DESIGN_REFERENCE"],
    ["file://example.com/reference.png", {}, "INVALID_DESIGN_REFERENCE"],
    [outsideImage, {}, "DESIGN_REFERENCE_OUTSIDE_REPOSITORY"],
    ["${QA_DESIGN}", { variables: { QA_DESIGN: 42 } }, "INVALID_DESIGN_REFERENCE"],
  ];
  for (const [reference, options, code] of cases) {
    await assert.rejects(
      () => resolveDesignReference(reference, { repositoryRoot: root, ...options }),
      (error) => error instanceof QaError && error.code === code,
    );
  }
});

test("design comparison rules normalize only concrete and internally consistent decisions", () => {
  const reference = { kind: "url", source: "https://design.example/reference.png" };
  const request = buildDesignComparisonRequest({
    reference,
    actual: { path: "screenshots/actual.png", image: { contents: IMAGE, extension: "png" } },
    viewport: DEFAULT_DESIGN_VIEWPORT,
    afterStep: 2,
  });
  assert.equal(request.checkpoint.afterStep, 2);
  assert.deepEqual(request.viewport, DEFAULT_DESIGN_VIEWPORT);
  assert.equal(request.rules, DESIGN_COMPARISON_RULES);
  assert(Object.isFrozen(request.rules));

  assert.equal(normalizeDesignComparison(null).status, "blocked");
  assert.equal(normalizeDesignComparison({ status: "unknown" }).status, "blocked");
  assert.match(normalizeDesignComparison({ status: "regression" }).explanation, /concrete/);
  assert.match(normalizeDesignComparison({
    status: "matched",
    findings: [{ category: "layout", status: "regression", explanation: "Order changed" }],
  }).explanation, /contradicted/);
  assert.match(normalizeDesignComparison({
    status: "regression",
    findings: [{ category: "pixels", status: "regression", explanation: "One pixel moved" }],
  }).explanation, /invalid finding/);

  assert.deepEqual(normalizeDesignComparison({
    status: "regression",
    explanation: " The action moved above the heading. ",
    findings: [{ category: "order", status: "regression", explanation: " Action precedes heading. " }],
    referenceScreenshot: IMAGE,
  }), {
    status: "regression",
    explanation: "The action moved above the heading.",
    findings: [{ category: "order", status: "regression", explanation: "Action precedes heading." }],
    referenceScreenshot: IMAGE,
  });
});

test("a matching implementation records declared-viewport evidence without a false regression", async (t) => {
  let comparisonRequest;
  let designScreenshotContext;
  const { result, workspace } = await runDemoDesign(t, "stable", (executor) => {
    const compare = executor.driver.compareDesign;
    const screenshot = executor.driver.screenshot;
    executor.driver.compareDesign = (request, context) => {
      comparisonRequest = { request, context };
      return compare(request, context);
    };
    executor.driver.screenshot = (context) => {
      if (context.design) designScreenshotContext = context;
      return screenshot(context);
    };
  });

  assert.equal(result.classification, "passed");
  assert.equal(result.design.status, "matched");
  assert.equal(result.design.referenceKind, "image");
  assert.equal(result.design.afterStep, 3);
  assert.deepEqual(result.design.viewport, { width: 1280, height: 900 });
  assert.deepEqual(designScreenshotContext.viewport, { width: 1280, height: 900 });
  assert.equal(comparisonRequest.request.checkpoint.afterStep, 3);
  assert.equal(comparisonRequest.request.reference.kind, "image");
  assert(result.design.findings.every((finding) => finding.status === "matched"));
  for (const evidence of [result.design.referenceScreenshot, result.design.actualScreenshot]) {
    assert(result.evidence.screenshots.includes(evidence));
    await readFile(path.join(workspace.runsDirectory, result.runId, evidence));
  }
  assert(result.events.some((event) => event.type === "design_started"));
  assert(result.events.some((event) => event.type === "design_completed" && event.status === "passed"));
});

test("an obvious seeded mismatch becomes an evidence-backed design regression", async (t) => {
  const { result } = await runDemoDesign(t, "design");
  assert.equal(result.classification, "design_regression");
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "passed", "passed"]);
  assert.equal(result.design.status, "regression");
  assert(result.design.findings.some((finding) => finding.category === "order" && finding.status === "regression"));
  assert(result.design.findings.some((finding) => finding.category === "style" && finding.status === "regression"));
  assert.match(result.explanation, /red warning panel/);
});

test("functional regressions take precedence and harmless drift can still heal with a matched design", async (t) => {
  const broken = await runDemoDesign(t, "broken");
  assert.equal(broken.result.classification, "functional_regression");
  assert.equal(broken.result.design.status, "not_checked");
  assert.match(broken.result.design.explanation, /checkpoint/);

  const drift = await runDemoDesign(t, "drift");
  assert.equal(drift.result.classification, "healed");
  assert.equal(drift.result.design.status, "matched");
  assert.equal(drift.result.steps[1].healing.outcome, "healed");
});

test("missing comparison capability and unsupported opinions block instead of guessing", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  await writeFile(path.join(root, "approved.png"), IMAGE);
  await workspace.saveSpec({
    version: 1,
    id: "focused-design",
    title: "Focused design check",
    environment: "local",
    design: { reference: "approved.png", afterStep: 1 },
    steps: [{ intent: "Open the result", expect: ["The result is visible"] }],
  });
  const base = {
    act: () => ({}),
    observe: () => true,
    screenshot: () => IMAGE,
  };

  const missing = await executeRun({
    workspace,
    specId: "focused-design",
    runId: "run_20260830_150000",
    executor: createNativeWebExecutor(base),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(missing.classification, "blocked");
  assert.equal(missing.design.status, "not_checked");
  assert.match(missing.design.explanation, /does not expose design comparison/);

  const unsupported = await executeRun({
    workspace,
    specId: "focused-design",
    runId: "run_20260830_150001",
    executor: createNativeWebExecutor({
      ...base,
      compareDesign: () => ({ status: "regression", explanation: "It looks wrong to me" }),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(unsupported.classification, "blocked");
  assert.equal(unsupported.design.status, "not_checked");
  assert.match(unsupported.design.explanation, /concrete reference-backed finding/);

  const missingActual = await executeRun({
    workspace,
    specId: "focused-design",
    runId: "run_20260830_150002",
    executor: createNativeWebExecutor({
      ...base,
      screenshot: (context) => context.design ? null : IMAGE,
      compareDesign: () => ({ status: "matched" }),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(missingActual.classification, "blocked");
  assert.match(missingActual.design.explanation, /could not be captured/);

  const throwing = await executeRun({
    workspace,
    specId: "focused-design",
    runId: "run_20260830_150003",
    executor: createNativeWebExecutor({
      ...base,
      compareDesign: () => { throw new Error("vision service unavailable"); },
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(throwing.classification, "blocked");
  assert.match(throwing.design.explanation, /vision service unavailable/);
});

test("remote references can persist comparator-supplied evidence and reject invalid artifacts", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await workspace.saveSpec({
    version: 1,
    id: "remote-design",
    title: "Remote design check",
    environment: "local",
    design: { reference: "https://design.example/approved.png", afterStep: 1 },
    steps: [{ intent: "Open the result", expect: ["The result is visible"] }],
  });
  const base = {
    act: () => ({}),
    observe: () => true,
    screenshot: () => IMAGE,
  };
  const matched = await executeRun({
    workspace,
    specId: "remote-design",
    runId: "run_20260830_150010",
    executor: createNativeWebExecutor({
      ...base,
      compareDesign: () => ({ status: "matched", referenceScreenshot: IMAGE }),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(matched.classification, "passed");
  assert.equal(matched.design.referenceKind, "url");
  assert(matched.evidence.screenshots.includes(matched.design.referenceScreenshot));

  const invalid = await executeRun({
    workspace,
    specId: "remote-design",
    runId: "run_20260830_150011",
    executor: createNativeWebExecutor({
      ...base,
      compareDesign: () => ({
        status: "matched",
        referenceScreenshot: { data: "not-an-image", extension: "gif" },
      }),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(invalid.classification, "blocked");
  assert.match(invalid.design.explanation, /reference evidence is invalid/);
});

test("an unresolved explicit reference blocks before native actions and remains reproducible", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await workspace.saveSpec({
    version: 1,
    id: "missing-design",
    title: "Missing design reference",
    environment: "local",
    design: { reference: "missing-reference.png" },
    steps: [{ intent: "Open the result", expect: ["The result is visible"] }],
  });
  let actions = 0;
  const result = await executeRun({
    workspace,
    specId: "missing-design",
    executor: createNativeWebExecutor({
      act: () => { actions += 1; return {}; },
      observe: () => true,
      screenshot: () => IMAGE,
      compareDesign: () => ({ status: "matched" }),
    }),
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(actions, 0);
  assert.equal(result.classification, "blocked");
  assert.equal(result.design.reference, "missing-reference.png");
  assert.equal(result.design.referenceKind, "unresolved");
  assert.equal(result.design.status, "not_checked");
  assert.match(result.design.explanation, /could not be read/);
});

test("workspace enforces design provenance, evidence, and classification consistency", async (t) => {
  const { result, workspace } = await runDemoDesign(t, "stable");
  await assert.rejects(
    () => workspace.saveResult(passingResult({ design: result.design })),
    (error) => error instanceof QaError && error.code === "UNEXPECTED_DESIGN_RESULT",
  );
  await assert.rejects(
    () => workspace.saveResult(passingResult({ specId: "design-checkout" })),
    (error) => error instanceof QaError && error.code === "MISSING_DESIGN_RESULT",
  );

  const changedReference = structuredClone(result);
  changedReference.design.reference = "another.png";
  await assert.rejects(
    () => workspace.saveResult(changedReference),
    (error) => error instanceof QaError && error.code === "DESIGN_REFERENCE_CHANGED",
  );

  const changedCheckpoint = structuredClone(result);
  changedCheckpoint.design.viewport.width = 1440;
  await assert.rejects(
    () => workspace.saveResult(changedCheckpoint),
    (error) => error instanceof QaError && error.code === "DESIGN_CHECKPOINT_CHANGED",
  );

  const missingEvidence = structuredClone(result);
  missingEvidence.evidence.screenshots = missingEvidence.evidence.screenshots
    .filter((item) => item !== missingEvidence.design.actualScreenshot);
  await assert.rejects(
    () => workspace.saveResult(missingEvidence),
    (error) => error instanceof QaError && error.code === "MISSING_DESIGN_EVIDENCE",
  );

  const unresolved = structuredClone(result);
  unresolved.design.referenceKind = "unresolved";
  await assert.rejects(
    () => workspace.saveResult(unresolved),
    (error) => error instanceof QaError && error.code === "UNRESOLVED_DESIGN_REFERENCE",
  );

  const unsupported = structuredClone(result);
  unsupported.classification = "design_regression";
  unsupported.design.status = "regression";
  unsupported.design.findings = [];
  await assert.rejects(
    () => workspace.saveResult(unsupported),
    (error) => error instanceof QaError && error.code === "UNSUPPORTED_DESIGN_REGRESSION",
  );

  const hidden = structuredClone(result);
  hidden.design.status = "regression";
  hidden.design.findings = [{ category: "layout", status: "regression", explanation: "Layout changed" }];
  await assert.rejects(
    () => workspace.saveResult(hidden),
    (error) => error instanceof QaError && error.code === "DESIGN_CLASSIFICATION_MISMATCH",
  );

  const unchecked = structuredClone(result);
  unchecked.design.status = "not_checked";
  await assert.rejects(
    () => workspace.saveResult(unchecked),
    (error) => error instanceof QaError && error.code === "DESIGN_NOT_CHECKED",
  );

  await assert.rejects(
    () => workspace.saveResult(passingResult({ classification: "design_regression" })),
    (error) => error instanceof QaError && error.code === "DESIGN_REGRESSION_WITHOUT_REFERENCE",
  );

  const functionalFailure = structuredClone(result);
  functionalFailure.classification = "design_regression";
  functionalFailure.design.status = "regression";
  functionalFailure.design.findings = [{ category: "layout", status: "regression", explanation: "Layout changed" }];
  functionalFailure.steps[0].status = "failed";
  functionalFailure.steps[0].expectations[0].status = "failed";
  await assert.rejects(
    () => workspace.saveResult(functionalFailure),
    (error) => error instanceof QaError && error.code === "DESIGN_REGRESSION_WITH_FAILED_STEP",
  );
});

test("recent history retains 20 runs per spec and deletion repairs the last-run pointer", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (let index = 0; index <= 20; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await workspace.saveResult(passingResult({
      runId: `run_20260830_1200${suffix}`,
      startedAt: `2026-08-30T12:00:${suffix}.000Z`,
      completedAt: `2026-08-30T12:00:${suffix}.500Z`,
    }));
  }

  const retained = await workspace.listResults({ specId: "checkout-card" });
  assert.equal(retained.length, 20);
  assert.equal(retained[0].runId, "run_20260830_120020");
  assert.equal(retained.at(-1).runId, "run_20260830_120001");
  await assert.rejects(
    () => workspace.loadResult("run_20260830_120000"),
    (error) => error instanceof QaError && error.code === "NOT_FOUND",
  );
  await workspace.saveResult(passingResult({
    runId: "run_20260830_110000",
    startedAt: "2026-08-30T11:00:00.000Z",
    completedAt: "2026-08-30T11:00:00.500Z",
  }));
  assert.equal((await workspace.readLastTest()).lastRunId, "run_20260830_110000");
  assert.equal((await workspace.listResults({ specId: "checkout-card" })).length, 20);
  assert.equal((await workspace.loadResult("run_20260830_110000")).runId, "run_20260830_110000");
  await assert.rejects(
    () => workspace.loadResult("run_20260830_120001"),
    (error) => error instanceof QaError && error.code === "NOT_FOUND",
  );
  assert.deepEqual((await workspace.listRecentResults({ specId: "checkout-card", limit: 3 }))
    .map((entry) => entry.runId), [
    "run_20260830_120020",
    "run_20260830_120019",
    "run_20260830_120018",
  ]);

  await workspace.deleteResult("run_20260830_110000");
  assert.equal((await workspace.readLastTest()).lastRunId, "run_20260830_120020");
  assert.equal((await workspace.listResults({ specId: "checkout-card" })).length, 19);
  assert.equal((await workspace.loadSpec("checkout-card")).id, "checkout-card");
  assert.equal((await workspace.loadFixture("login-customer")).id, "login-customer");
  await assert.rejects(
    () => workspace.listResults({ limit: 0 }),
    (error) => error instanceof QaError && error.code === "INVALID_RESULT_LIMIT",
  );
  await assert.rejects(
    () => workspace.pruneResults("checkout-card", 0),
    (error) => error instanceof QaError && error.code === "INVALID_RESULT_LIMIT",
  );
});
