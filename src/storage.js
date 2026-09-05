import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseJson, parseYaml, stringifyJson, stringifyYaml } from "./documents.js";
import { designConfigurationForSpec } from "./design.js";
import { QaError } from "./errors.js";
import { assertStableId, validateDocument } from "./schema-validator.js";
import { SAMPLE_ENVIRONMENTS, SAMPLE_FIXTURES, SAMPLE_SPEC, SAMPLE_SPECS } from "./samples.js";

export const MAX_RECENT_RUNS_PER_SPEC = 20;

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function atomicWriteFile(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;

  try {
    if (typeof contents !== "string" && !Buffer.isBuffer(contents) && !(contents instanceof Uint8Array)) {
      throw new TypeError("contents must be text or binary data");
    }
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, typeof contents === "string" ? "utf8" : undefined);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw new QaError("ATOMIC_WRITE_FAILED", `Could not safely write ${filePath}`, [], { cause: error });
  }
}

async function readText(filePath, label) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new QaError("NOT_FOUND", `${label} does not exist`, [
        { path: filePath, message: "file not found" },
      ]);
    }
    throw error;
  }
}

function fixtureIds(spec) {
  const plan = spec.fixtures ?? {};
  return [
    ...(plan.before ?? []),
    ...(plan.after ?? []),
    ...(plan.between ?? []).flatMap((entry) => entry.fixtures),
  ];
}

export class QaWorkspace {
  constructor(repositoryRoot = process.cwd()) {
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.qaDirectory = path.join(this.repositoryRoot, ".qa");
    this.environmentsPath = path.join(this.qaDirectory, "environments.yaml");
    this.fixturesDirectory = path.join(this.qaDirectory, "fixtures");
    this.specsDirectory = path.join(this.qaDirectory, "specs");
    this.runsDirectory = path.join(this.qaDirectory, "runs");
    this.lastTestPath = path.join(this.qaDirectory, "last-test.json");
  }

  async ensureDirectories() {
    await Promise.all([
      mkdir(this.fixturesDirectory, { recursive: true }),
      mkdir(this.specsDirectory, { recursive: true }),
      mkdir(this.runsDirectory, { recursive: true }),
    ]);
  }

  async init({ seed = true } = {}) {
    await this.ensureDirectories();
    const created = [];
    const skipped = [];

    if (!(await exists(this.environmentsPath))) {
      await this.saveEnvironments(SAMPLE_ENVIRONMENTS);
      created.push(path.relative(this.repositoryRoot, this.environmentsPath));
    } else {
      await this.loadEnvironments();
      skipped.push(path.relative(this.repositoryRoot, this.environmentsPath));
    }

    if (!seed) return { created, skipped };

    for (const fixture of SAMPLE_FIXTURES) {
      const fixturePath = this.fixturePath(fixture.id);
      if (await exists(fixturePath)) {
        await this.loadFixture(fixture.id);
        skipped.push(path.relative(this.repositoryRoot, fixturePath));
      } else {
        await this.saveFixture(fixture);
        created.push(path.relative(this.repositoryRoot, fixturePath));
      }
    }

    for (const sampleSpec of SAMPLE_SPECS) {
      const sampleSpecPath = this.specPath(sampleSpec.id);
      if (await exists(sampleSpecPath)) {
        await this.loadSpec(sampleSpec.id);
        skipped.push(path.relative(this.repositoryRoot, sampleSpecPath));
      } else {
        await this.saveSpec(sampleSpec);
        created.push(path.relative(this.repositoryRoot, sampleSpecPath));
      }
    }

    if (!(await exists(this.lastTestPath))) {
      await this.selectSpec(SAMPLE_SPEC.id, SAMPLE_SPEC.environment);
      created.push(path.relative(this.repositoryRoot, this.lastTestPath));
    } else {
      await this.readLastTest();
      skipped.push(path.relative(this.repositoryRoot, this.lastTestPath));
    }

    return { created, skipped };
  }

  fixturePath(id) {
    assertStableId(id, "$.fixtureId");
    return path.join(this.fixturesDirectory, `${id}.yaml`);
  }

  specPath(id) {
    assertStableId(id, "$.specId");
    return path.join(this.specsDirectory, `${id}.yaml`);
  }

  resultPath(runId) {
    if (typeof runId !== "string" || !/^run_[0-9]{8}_[0-9]{6}(?:_[a-z0-9]+)?$/.test(runId)) {
      throw new QaError("INVALID_RUN_ID", "Run ID is invalid", [
        { path: "$.runId", message: "expected run_YYYYMMDD_HHMMSS with an optional lowercase suffix" },
      ]);
    }
    return path.join(this.runsDirectory, runId, "result.json");
  }

  screenshotPath(runId, fileName) {
    this.resultPath(runId);
    if (typeof fileName !== "string" || !/^[a-z0-9][a-z0-9-]*\.(?:png|jpe?g|webp)$/.test(fileName)) {
      throw new QaError("INVALID_SCREENSHOT_NAME", "Screenshot filename is invalid", [
        { path: "$.fileName", message: "use lowercase letters, numbers, and hyphens with a supported image extension" },
      ]);
    }
    return path.join(this.runsDirectory, runId, "screenshots", fileName);
  }

  async saveScreenshot(runId, fileName, contents) {
    const filePath = this.screenshotPath(runId, fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, contents);
    return path.posix.join("screenshots", fileName);
  }

  async loadEnvironments() {
    const source = await readText(this.environmentsPath, "Environments file");
    return this.validateEnvironments(source);
  }

  validateEnvironments(valueOrYaml) {
    return validateDocument("environments", parseYaml(valueOrYaml, "Environments YAML"));
  }

  async saveEnvironments(valueOrYaml) {
    await this.ensureDirectories();
    const value = this.validateEnvironments(valueOrYaml);
    const specNames = (await readdir(this.specsDirectory)).filter((name) => name.endsWith(".yaml"));
    for (const name of specNames) {
      const source = await readText(path.join(this.specsDirectory, name), `Spec ${name}`);
      const spec = validateDocument("spec", parseYaml(source, `Spec ${name}`));
      if (!Object.hasOwn(value.environments, spec.environment)) {
        throw new QaError("ENVIRONMENT_IN_USE", `Environment ${spec.environment} is still referenced`, [
          { path: `$.environments.${spec.environment}`, message: `required by spec ${spec.id}` },
        ]);
      }
    }
    await atomicWriteFile(this.environmentsPath, stringifyYaml(value));
    return value;
  }

  async listEnvironments() {
    const { environments } = await this.loadEnvironments();
    return Object.entries(environments)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, environment]) => ({ id, ...environment }));
  }

  async loadFixture(id) {
    const filePath = this.fixturePath(id);
    const value = this.validateFixture(await readText(filePath, `Fixture ${id}`), `Fixture ${id}`);
    if (value.id !== id) {
      throw new QaError("ID_MISMATCH", `Fixture filename and document ID do not match`, [
        { path: "$.id", message: `expected ${id} for ${path.basename(filePath)}` },
      ]);
    }
    return value;
  }

  validateFixture(valueOrYaml, label = "Fixture YAML") {
    return validateDocument("fixture", parseYaml(valueOrYaml, label));
  }

  async saveFixture(valueOrYaml) {
    await this.ensureDirectories();
    const value = this.validateFixture(valueOrYaml);
    await atomicWriteFile(this.fixturePath(value.id), stringifyYaml(value));
    return value;
  }

  async listFixtures() {
    await this.ensureDirectories();
    const names = (await readdir(this.fixturesDirectory)).filter((name) => name.endsWith(".yaml"));
    const fixtures = await Promise.all(names.map((name) => this.loadFixture(name.slice(0, -5))));
    return fixtures.sort((left, right) => left.id.localeCompare(right.id));
  }

  async deleteFixture(id) {
    await this.loadFixture(id);
    const referencing = (await this.listSpecs()).filter((spec) => fixtureIds(spec).includes(id));
    if (referencing.length > 0) {
      throw new QaError("FIXTURE_IN_USE", `Fixture ${id} is still referenced`, [
        { path: "$.fixtures", message: `used by ${referencing.map((spec) => spec.id).join(", ")}` },
      ]);
    }
    await unlink(this.fixturePath(id));
  }

  async validateSpecReferences(spec) {
    const { environments } = await this.loadEnvironments();
    if (!Object.hasOwn(environments, spec.environment)) {
      throw new QaError("UNKNOWN_ENVIRONMENT", `Spec ${spec.id} references an unknown environment`, [
        { path: "$.environment", message: `${spec.environment} is not defined in .qa/environments.yaml` },
      ]);
    }

    const availableFixtures = new Set((await this.listFixtures()).map((fixture) => fixture.id));
    const unknownFixtures = [...new Set(fixtureIds(spec).filter((id) => !availableFixtures.has(id)))];
    if (unknownFixtures.length > 0) {
      throw new QaError("UNKNOWN_FIXTURE", `Spec ${spec.id} references unknown fixtures`,
        unknownFixtures.map((id) => ({ path: "$.fixtures", message: `${id} is not defined in .qa/fixtures` })),
      );
    }

    for (const [index, entry] of (spec.fixtures?.between ?? []).entries()) {
      if (entry.afterStep >= spec.steps.length) {
        throw new QaError("INVALID_FIXTURE_POSITION", `Spec ${spec.id} has an invalid between-step fixture`, [
          {
            path: `$.fixtures.between[${index}].afterStep`,
            message: `must be less than the ${spec.steps.length} test steps`,
          },
        ]);
      }
    }
    if (spec.design?.afterStep > spec.steps.length) {
      throw new QaError("INVALID_DESIGN_POSITION", `Spec ${spec.id} has an invalid design checkpoint`, [
        {
          path: "$.design.afterStep",
          message: `must reference one of the ${spec.steps.length} test steps`,
        },
      ]);
    }
    return spec;
  }

  async loadSpec(id) {
    const filePath = this.specPath(id);
    const value = validateDocument("spec", parseYaml(await readText(filePath, `Spec ${id}`), `Spec ${id}`));
    if (value.id !== id) {
      throw new QaError("ID_MISMATCH", `Spec filename and document ID do not match`, [
        { path: "$.id", message: `expected ${id} for ${path.basename(filePath)}` },
      ]);
    }
    return this.validateSpecReferences(value);
  }

  async validateSpec(valueOrYaml, label = "Spec YAML") {
    const value = validateDocument("spec", parseYaml(valueOrYaml, label));
    return this.validateSpecReferences(value);
  }

  async saveSpec(valueOrYaml) {
    await this.ensureDirectories();
    const value = await this.validateSpec(valueOrYaml);
    await atomicWriteFile(this.specPath(value.id), stringifyYaml(value));
    return value;
  }

  async listSpecs() {
    await this.ensureDirectories();
    const names = (await readdir(this.specsDirectory)).filter((name) => name.endsWith(".yaml"));
    const specs = await Promise.all(names.map((name) => this.loadSpec(name.slice(0, -5))));
    return specs.sort((left, right) => left.id.localeCompare(right.id));
  }

  async deleteSpec(id) {
    await this.loadSpec(id);
    if (await exists(this.lastTestPath)) {
      const selected = await this.readLastTest();
      if (selected.specId === id) {
        throw new QaError("SPEC_SELECTED", `Spec ${id} is the most recently selected test`, [
          { path: "$.specId", message: "select another spec before deleting this one" },
        ]);
      }
    }
    await unlink(this.specPath(id));
  }

  async selectSpec(id, environment) {
    const spec = await this.loadSpec(id);
    const selectedEnvironment = environment || spec.environment;
    const { environments } = await this.loadEnvironments();
    if (!Object.hasOwn(environments, selectedEnvironment)) {
      throw new QaError("UNKNOWN_ENVIRONMENT", `Cannot select unknown environment ${selectedEnvironment}`, [
        { path: "$.environment", message: "environment is not defined in .qa/environments.yaml" },
      ]);
    }
    const value = validateDocument("lastTest", { specId: id, environment: selectedEnvironment });
    await atomicWriteFile(this.lastTestPath, stringifyJson(value));
    return value;
  }

  async readLastTest() {
    const value = validateDocument(
      "lastTest",
      parseJson(await readText(this.lastTestPath, "Last-test pointer"), "Last-test JSON"),
    );
    await this.loadSpec(value.specId);
    const { environments } = await this.loadEnvironments();
    if (!Object.hasOwn(environments, value.environment)) {
      throw new QaError("UNKNOWN_ENVIRONMENT", "Last-test pointer references an unknown environment", [
        { path: "$.environment", message: `${value.environment} is not defined` },
      ]);
    }
    if (value.lastRunId) {
      const result = await this.loadResult(value.lastRunId);
      if (result.specId !== value.specId) {
        throw new QaError("RUN_MISMATCH", "Last-test pointer references a run for another spec", [
          { path: "$.lastRunId", message: `${value.lastRunId} belongs to ${result.specId}` },
        ]);
      }
      if (result.environment !== value.environment) {
        throw new QaError("RUN_MISMATCH", "Last-test pointer and run use different environments", [
          { path: "$.lastRunId", message: `${value.lastRunId} ran on ${result.environment}` },
        ]);
      }
    }
    return value;
  }

  async loadResult(runId) {
    return this.validateResult(await readText(this.resultPath(runId), `Run ${runId}`), `Run ${runId}`);
  }

  validateResult(valueOrJson, label = "Run result JSON") {
    return validateDocument("result", parseJson(valueOrJson, label));
  }

  async saveResult(valueOrJson) {
    await this.ensureDirectories();
    const value = this.validateResult(valueOrJson);
    const spec = await this.loadSpec(value.specId);
    const { environments } = await this.loadEnvironments();
    if (!Object.hasOwn(environments, value.environment)) {
      throw new QaError("UNKNOWN_ENVIRONMENT", `Run ${value.runId} references an unknown environment`, [
        { path: "$.environment", message: `${value.environment} is not defined` },
      ]);
    }
    if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
      throw new QaError("INVALID_RUN_TIME", `Run ${value.runId} completed before it started`, [
        { path: "$.completedAt", message: "must be at or after startedAt" },
      ]);
    }

    const seenStepIndexes = new Set();
    for (const [resultIndex, step] of value.steps.entries()) {
      if (seenStepIndexes.has(step.index)) {
        throw new QaError("DUPLICATE_RESULT_STEP", `Run ${value.runId} records a step more than once`, [
          { path: `$.steps[${resultIndex}].index`, message: `${step.index} is duplicated` },
        ]);
      }
      seenStepIndexes.add(step.index);
      const specStep = spec.steps[step.index - 1];
      if (!specStep) {
        throw new QaError("UNKNOWN_RESULT_STEP", `Run ${value.runId} references an unknown test step`, [
          { path: `$.steps[${resultIndex}].index`, message: `spec ${spec.id} has only ${spec.steps.length} steps` },
        ]);
      }
      if (step.intent !== specStep.intent) {
        throw new QaError("RESULT_INTENT_CHANGED", `Run ${value.runId} changed a test intent`, [
          { path: `$.steps[${resultIndex}].intent`, message: "must match the selected spec exactly" },
        ]);
      }
      const recordedExpectations = step.expectations.map((entry) => entry.expectation);
      if (JSON.stringify(recordedExpectations) !== JSON.stringify(specStep.expect)) {
        throw new QaError("RESULT_EXPECTATION_CHANGED", `Run ${value.runId} changed test expectations`, [
          { path: `$.steps[${resultIndex}].expectations`, message: "must preserve the selected spec's expectations and order" },
        ]);
      }
    }

    const allowedFixtures = {
      before: new Set(spec.fixtures?.before ?? []),
      between: new Set((spec.fixtures?.between ?? []).flatMap((entry) => entry.fixtures)),
      after: new Set(spec.fixtures?.after ?? []),
    };
    for (const [fixtureIndex, fixture] of (value.fixtures ?? []).entries()) {
      if (!allowedFixtures[fixture.phase].has(fixture.fixtureId)) {
        throw new QaError("UNKNOWN_RESULT_FIXTURE", `Run ${value.runId} records an unexpected fixture`, [
          {
            path: `$.fixtures[${fixtureIndex}].fixtureId`,
            message: `${fixture.fixtureId} is not declared in the spec's ${fixture.phase} fixture plan`,
          },
        ]);
      }
    }

    for (const [screenshotIndex, screenshot] of (value.evidence?.screenshots ?? []).entries()) {
      const screenshotPath = path.join(this.runsDirectory, value.runId, ...screenshot.split("/"));
      if (!(await exists(screenshotPath))) {
        throw new QaError("MISSING_SCREENSHOT", `Run ${value.runId} references a missing screenshot`, [
          { path: `$.evidence.screenshots[${screenshotIndex}]`, message: `${screenshot} does not exist` },
        ]);
      }
    }

    const evidenceScreenshots = new Set(value.evidence?.screenshots ?? []);
    if (!spec.design && value.design) {
      throw new QaError("UNEXPECTED_DESIGN_RESULT", `Run ${value.runId} records an undeclared design comparison`, [
        { path: "$.design", message: "the selected spec has no explicit design reference" },
      ]);
    }
    if (spec.design && !value.design) {
      throw new QaError("MISSING_DESIGN_RESULT", `Run ${value.runId} omitted its declared design comparison`, [
        { path: "$.design", message: "a spec with design metadata must record the comparison outcome" },
      ]);
    }
    if (spec.design && value.design) {
      const expected = designConfigurationForSpec(spec.design, spec.steps.length);
      if (value.design.reference !== expected.reference) {
        throw new QaError("DESIGN_REFERENCE_CHANGED", `Run ${value.runId} changed the design reference`, [
          { path: "$.design.reference", message: "must match the selected spec exactly" },
        ]);
      }
      if (
        value.design.afterStep !== expected.afterStep
        || value.design.viewport.width !== expected.viewport.width
        || value.design.viewport.height !== expected.viewport.height
      ) {
        throw new QaError("DESIGN_CHECKPOINT_CHANGED", `Run ${value.runId} changed the design checkpoint`, [
          { path: "$.design", message: "viewport and afterStep must match the selected spec" },
        ]);
      }
      if (new Set(["matched", "regression"]).has(value.design.status)) {
        if (value.design.referenceKind === "unresolved") {
          throw new QaError("UNRESOLVED_DESIGN_REFERENCE", `Run ${value.runId} checked an unresolved design reference`, [
            { path: "$.design.referenceKind", message: "a completed comparison requires a resolved reference" },
          ]);
        }
        if (!value.design.actualScreenshot || !evidenceScreenshots.has(value.design.actualScreenshot)) {
          throw new QaError("MISSING_DESIGN_EVIDENCE", `Run ${value.runId} is missing its actual design screenshot`, [
            { path: "$.design.actualScreenshot", message: "must reference a screenshot in $.evidence.screenshots" },
          ]);
        }
      }
      if (value.design.referenceScreenshot && !evidenceScreenshots.has(value.design.referenceScreenshot)) {
        throw new QaError("MISSING_DESIGN_EVIDENCE", `Run ${value.runId} is missing its reference screenshot`, [
          { path: "$.design.referenceScreenshot", message: "must reference a screenshot in $.evidence.screenshots" },
        ]);
      }
      if (
        value.design.status === "regression"
        && !(value.design.findings ?? []).some((finding) => finding.status === "regression")
      ) {
        throw new QaError("UNSUPPORTED_DESIGN_REGRESSION", `Run ${value.runId} lacks a concrete design finding`, [
          { path: "$.design.findings", message: "a regression requires a reference-backed regression finding" },
        ]);
      }
    }

    const successfulHealings = [];
    for (const [stepIndex, step] of value.steps.entries()) {
      if (!step.healing || step.healing.outcome !== "healed") continue;
      successfulHealings.push(step);
      if (step.status !== "passed") {
        throw new QaError("HEALING_STATUS_MISMATCH", `Run ${value.runId} records unsuccessful healing as passed`, [
          { path: `$.steps[${stepIndex}].status`, message: "must be passed when healing outcome is healed" },
        ]);
      }
      for (const field of ["beforeScreenshot", "afterScreenshot"]) {
        const screenshot = step.healing[field];
        if (!screenshot || !evidenceScreenshots.has(screenshot)) {
          throw new QaError("MISSING_HEALING_EVIDENCE", `Run ${value.runId} is missing healing screenshot evidence`, [
            {
              path: `$.steps[${stepIndex}].healing.${field}`,
              message: "must reference a screenshot in $.evidence.screenshots",
            },
          ]);
        }
      }
    }
    if (value.classification === "healed") {
      if (successfulHealings.length === 0) {
        throw new QaError("HEALED_WITHOUT_RECOVERY", `Run ${value.runId} has no successfully healed step`, [
          { path: "$.classification", message: "healed requires a step with healing.outcome set to healed" },
        ]);
      }
      if (value.steps.some((step) => step.status !== "passed")) {
        throw new QaError("HEALED_WITH_FAILED_STEP", `Run ${value.runId} cannot be healed while a test step did not pass`, [
          { path: "$.steps", message: "every test step must pass for a healed run" },
        ]);
      }
    } else if (value.classification === "passed" && successfulHealings.length > 0) {
      throw new QaError("HEALING_CLASSIFICATION_MISMATCH", `Run ${value.runId} hides a successful recovery`, [
        { path: "$.classification", message: "use healed when recovery was required" },
      ]);
    }
    if (value.classification === "design_regression") {
      if (!spec.design || value.design?.status !== "regression") {
        throw new QaError("DESIGN_REGRESSION_WITHOUT_REFERENCE", `Run ${value.runId} lacks a supported design regression`, [
          { path: "$.classification", message: "design_regression requires an explicit reference and regression result" },
        ]);
      }
      if (value.steps.some((step) => step.status !== "passed")) {
        throw new QaError("DESIGN_REGRESSION_WITH_FAILED_STEP", `Run ${value.runId} also has a functional failure`, [
          { path: "$.steps", message: "functional failures take precedence over design classification" },
        ]);
      }
    }
    if (new Set(["passed", "healed"]).has(value.classification) && value.design?.status === "regression") {
      throw new QaError("DESIGN_CLASSIFICATION_MISMATCH", `Run ${value.runId} hides a design regression`, [
        { path: "$.classification", message: "use design_regression for a supported design mismatch" },
      ]);
    }
    if (new Set(["passed", "healed"]).has(value.classification) && value.design?.status === "not_checked") {
      throw new QaError("DESIGN_NOT_CHECKED", `Run ${value.runId} passed without completing its design check`, [
        { path: "$.design.status", message: "an explicit design reference must be checked or block the run" },
      ]);
    }

    const resultPath = this.resultPath(value.runId);
    await mkdir(path.dirname(resultPath), { recursive: true });
    await atomicWriteFile(resultPath, stringifyJson(value));
    const pointer = validateDocument("lastTest", {
      specId: value.specId,
      environment: value.environment,
      lastRunId: value.runId,
    });
    await atomicWriteFile(this.lastTestPath, stringifyJson(pointer));
    await this.pruneResults(value.specId, MAX_RECENT_RUNS_PER_SPEC, value.runId);
    return value;
  }

  async listResults({ specId, limit } = {}) {
    if (specId !== undefined) assertStableId(specId, "$.specId");
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QaError("INVALID_RESULT_LIMIT", "Result limit must be a positive integer", [
        { path: "$.limit", message: "must be a positive integer" },
      ]);
    }
    await this.ensureDirectories();
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    const runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const results = [];
    for (const runId of runIds) {
      if (await exists(path.join(this.runsDirectory, runId, "result.json"))) {
        results.push(await this.loadResult(runId));
      }
    }
    const sorted = results
      .filter((result) => specId === undefined || result.specId === specId)
      .sort((left, right) => (
        right.completedAt.localeCompare(left.completedAt) || right.runId.localeCompare(left.runId)
      ));
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }

  listRecentResults({ specId, limit = MAX_RECENT_RUNS_PER_SPEC } = {}) {
    return this.listResults({ specId, limit });
  }

  async pruneResults(specId, keep = MAX_RECENT_RUNS_PER_SPEC, preserveRunId) {
    assertStableId(specId, "$.specId");
    if (!Number.isInteger(keep) || keep < 1) {
      throw new QaError("INVALID_RESULT_LIMIT", "Result retention must be a positive integer", [
        { path: "$.keep", message: "must be a positive integer" },
      ]);
    }
    const results = await this.listResults({ specId });
    const retained = new Set(results.slice(0, keep).map((result) => result.runId));
    if (preserveRunId && results.some((result) => result.runId === preserveRunId) && !retained.has(preserveRunId)) {
      retained.delete(results[keep - 1].runId);
      retained.add(preserveRunId);
    }
    const expired = results.filter((result) => !retained.has(result.runId));
    for (const result of expired) {
      await rm(path.dirname(this.resultPath(result.runId)), { recursive: true });
    }
    return expired.map((result) => result.runId);
  }

  async deleteResult(runId) {
    const result = await this.loadResult(runId);
    const selected = (await exists(this.lastTestPath)) ? await this.readLastTest() : null;
    await rm(path.dirname(this.resultPath(runId)), { recursive: true });
    if (selected?.lastRunId === runId) {
      const replacement = (await this.listResults({ specId: result.specId }))
        .find((candidate) => candidate.environment === result.environment);
      const pointer = validateDocument("lastTest", {
        specId: result.specId,
        environment: result.environment,
        ...(replacement ? { lastRunId: replacement.runId } : {}),
      });
      await atomicWriteFile(this.lastTestPath, stringifyJson(pointer));
    }
    return result;
  }

  async validateAll() {
    const environments = await this.loadEnvironments();
    const fixtures = await this.listFixtures();
    const specs = await this.listSpecs();
    const runs = await this.listResults();
    const lastTest = (await exists(this.lastTestPath)) ? await this.readLastTest() : null;
    return {
      environments: Object.keys(environments.environments).length,
      fixtures: fixtures.length,
      specs: specs.length,
      runs: runs.length,
      lastTest,
    };
  }
}
