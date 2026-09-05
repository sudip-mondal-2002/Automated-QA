import assert from "node:assert/strict";
import test from "node:test";
import { draftSpec, QaError, slugify, validateDocument } from "../src/index.js";

test("drafts a valid editable checkout spec from natural language", () => {
  const spec = draftSpec("a logged-in customer completes checkout", {
    environment: "local",
    beforeFixtures: ["login-customer"],
  });

  validateDocument("spec", spec);
  assert.equal(spec.id, "logged-in-customer-completes-checkout");
  assert.equal(spec.title, "Logged-in customer completes checkout");
  assert.deepEqual(spec.fixtures.before, ["login-customer"]);
  assert.deepEqual(spec.steps[0].expect, ["Order confirmation is visible"]);
});

test("draft options preserve explicit user expectations", () => {
  const spec = draftSpec("verify checkout", {
    id: "checkout-happy-path",
    expectations: ["Receipt number is visible", "No error message is shown"],
  });
  assert.deepEqual(spec.steps[0].expect, ["Receipt number is visible", "No error message is shown"]);
});

test("stable IDs reject paths and unsafe punctuation", () => {
  assert.throws(
    () => draftSpec("checkout", { id: "../checkout" }),
    (error) => error instanceof QaError && error.code === "INVALID_ID",
  );
  assert.equal(slugify("Customer's checkout / card"), "customers-checkout-card");
});

test("empty natural-language requests fail clearly", () => {
  assert.throws(
    () => draftSpec("   "),
    (error) => error instanceof QaError && error.code === "MISSING_REQUIREMENT",
  );
});
