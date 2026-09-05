import assert from "node:assert/strict";
import test from "node:test";
import { parseJson, parseYaml, QaError, validateDocument } from "../src/index.js";

test("parses editable YAML documents", () => {
  assert.deepEqual(parseYaml("version: 1\nid: sample-test\n"), {
    version: 1,
    id: "sample-test",
  });
});

test("reports invalid YAML with a line and column", () => {
  assert.throws(
    () => parseYaml("version: 1\nsteps:\n  - intent: [broken\n", "Broken spec"),
    (error) => {
      assert(error instanceof QaError);
      assert.equal(error.code, "INVALID_YAML");
      assert.match(error.issues[0].path, /line [0-9]+, column [0-9]+/);
      return true;
    },
  );
});

test("rejects duplicate YAML keys", () => {
  assert.throws(
    () => parseYaml("version: 1\nversion: 1\n"),
    (error) => error instanceof QaError && error.code === "INVALID_YAML",
  );
});

test("reports JSON parse errors without leaking implementation details", () => {
  assert.throws(
    () => parseJson('{"specId": }', "Last test"),
    (error) => error instanceof QaError && error.code === "INVALID_JSON" && error.issues[0].path === "$",
  );
});

test("schema failures use actionable document paths", () => {
  assert.throws(
    () => validateDocument("fixture", {
      version: 1,
      id: "login-customer",
      title: "Login",
      inputs: { password: "plaintext-secret" },
      steps: [{ intent: "Log in" }],
      expect: ["Dashboard is visible"],
    }),
    (error) => {
      assert(error instanceof QaError);
      assert.equal(error.code, "VALIDATION_FAILED");
      assert(error.issues.some((entry) => entry.path === "$.inputs.password"));
      return true;
    },
  );
});

test("result taxonomy is intentionally small", () => {
  assert.throws(
    () => validateDocument("result", {
      version: 1,
      runId: "run_20260830_120000",
      specId: "checkout-card",
      environment: "local",
      classification: "flaky",
      startedAt: "2026-08-30T12:00:00Z",
      completedAt: "2026-08-30T12:00:01Z",
      steps: [],
    }),
    (error) => error instanceof QaError && error.issues.some((entry) => entry.path === "$.classification"),
  );
});
