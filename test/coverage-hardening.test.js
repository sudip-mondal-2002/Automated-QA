import assert from "node:assert/strict";
import test from "node:test";
import { decideVerdict, evaluatePlan, scorePlan } from "../src/coverage.js";

function makeCtx(overrides = {}) {
  const siteMap = {
    origin: "http://127.0.0.1:4000",
    pages: [{ path: "/", forms: [], signals: {} }],
    ...overrides.siteMap,
  };
  const plan = {
    id: "plan_ctx",
    attempt: 1,
    flows: [{ id: "f1", title: "Open home", category: "happy", pages: ["/"], steps: [{ intent: "Open", expect: ["Home visible", "No error"] }] }],
    ...overrides.plan,
  };
  return {
    siteMap,
    plan,
    prd: { requirements: [] },
    prompt: "",
    ...overrides,
  };
}

test("skipped rules drop out of numerator and denominator", () => {
  assert.equal(scorePlan([]), 0);
  assert.equal(scorePlan([{ severity: "blocking", status: "skipped" }, { severity: "advisory", status: "skipped" }]), 1);
  assert.equal(scorePlan([{ severity: "blocking", status: "pass" }, { severity: "advisory", status: "skipped" }]), 1);
  assert.equal(scorePlan([{ severity: "blocking", status: "pass" }, { severity: "advisory", status: "fail" }]), 0.75);

  const ctx = makeCtx({ siteMap: { origin: "http://x", pages: [{ path: "/", forms: [], signals: {} }] }, plan: { id: "p", attempt: 1, flows: [{ id: "f1", title: "Open", category: "happy", pages: ["/"], steps: [{ intent: "Open", expect: ["A", "B"] }] }] } });
  const report = evaluatePlan(ctx);
  const skipped = report.checklist.filter((c) => c.status === "skipped").map((c) => c.ruleId);
  assert.ok(skipped.includes("happy-path-coverage"));
  assert.ok(skipped.includes("error-state-per-form"));
  assert.ok(skipped.includes("auth-negative"));
  assert.ok(skipped.includes("prompt-honored"));
  assert.ok(skipped.includes("edge-boundary"));
  assert.ok(skipped.includes("destructive-guard"));
  assert.ok(skipped.includes("prd-coverage"));
});

test("decideVerdict oscillation guard escalates non-improving replans", () => {
  const checklist = [{ ruleId: "error-state-per-form", severity: "blocking", status: "fail", gaps: [{ ruleId: "error-state-per-form", autoFixable: true }] }];
  assert.equal(decideVerdict({ checklist, attempt: 1, maxReplans: 3, score: 0.6, prevScore: 0.5 }), "replan");
  assert.equal(decideVerdict({ checklist, attempt: 1, maxReplans: 3, score: 0.5, prevScore: 0.5 }), "escalate");
  assert.equal(decideVerdict({ checklist, attempt: 1, maxReplans: 3, score: 0.4, prevScore: 0.5 }), "escalate");
});

test("low score without blocking failures still replans then escalates", () => {
  const checklist = [{ ruleId: "category-mix", severity: "blocking", status: "fail", gaps: [] }];
  // category-mix has no gaps -> unfixable -> escalate immediately
  assert.equal(decideVerdict({ checklist, attempt: 1, maxReplans: 2, score: 0.5 }), "escalate");
  const fixableLow = [{ ruleId: "happy-path-coverage", severity: "blocking", status: "pass", gaps: [] }, { ruleId: "orphan-page", severity: "advisory", status: "fail", gaps: [{ autoFixable: true }] }];
  assert.equal(decideVerdict({ checklist: fixableLow, attempt: 1, maxReplans: 2, score: 0.6, prevScore: 0.5 }), "replan");
  assert.equal(decideVerdict({ checklist: fixableLow, attempt: 2, maxReplans: 2, score: 0.6 }), "escalate");
});
