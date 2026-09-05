import assert from "node:assert/strict";
import test from "node:test";
import { COVERAGE_RULES, decideVerdict, evaluatePlan, renderGapsMarkdown, scorePlan } from "../src/coverage.js";

function baseSiteMap() {
  return {
    origin: "http://127.0.0.1:4000",
    pages: [
      { path: "/login", forms: [{ action: "/login", inputs: [{ name: "u", type: "text" }, { name: "p", type: "password" }] }], signals: {} },
      { path: "/cart", forms: [{ action: "/checkout", inputs: [{ name: "card", type: "text", required: true }] }], signals: { list: true, numeric: true, payment: true, destructive: true } },
      { path: "/dashboard", forms: [], signals: {} },
    ],
  };
}

function passingPlan() {
  return {
    id: "plan_1",
    attempt: 1,
    flows: [
      { id: "flow_login_happy", title: "Sign in via /login", category: "happy", priority: "critical", pages: ["/login"], steps: [{ intent: "Sign in", expect: ["Dashboard visible", "No error"] }], requirementIds: ["REQ-1"] },
      { id: "flow_cart_happy", title: "Submit form on /cart", category: "happy", priority: "high", pages: ["/cart"], steps: [{ intent: "Place order", expect: ["Confirmation visible", "Only one order is created"] }], requirementIds: ["REQ-1"] },
      { id: "flow_dash_happy", title: "Open dashboard", category: "happy", priority: "medium", pages: ["/dashboard"], steps: [{ intent: "Open dashboard", expect: ["Dashboard visible", "Stats shown"] }], requirementIds: [] },
      { id: "flow_login_invalid_creds", title: "Reject invalid credentials", category: "error", priority: "critical", pages: ["/login"], steps: [{ intent: "Sign in with invalid credentials", expect: ["Error shown", "No session"] }], requirementIds: [] },
      { id: "flow_unauthenticated_redirect", title: "Redirect unauthenticated deep links", category: "error", priority: "high", pages: ["/dashboard"], steps: [{ intent: "Open protected", expect: ["Sign in required", "No data"] }], requirementIds: [] },
      { id: "flow_cart_empty", title: "Reject empty card on /cart", category: "error", priority: "high", pages: ["/cart"], steps: [{ intent: "Submit blank", expect: ["Validation error", "No record"] }], requirementIds: [] },
      { id: "flow_cart_edge", title: "Guard double submission on /cart", category: "edge", priority: "medium", pages: ["/cart"], steps: [{ intent: "Submit twice", expect: ["Only one order is created", "Warning shown"] }], requirementIds: [] },
      { id: "flow_cart_boundary", title: "Reject out-of-range quantity on /cart", category: "edge", priority: "medium", pages: ["/cart"], steps: [{ intent: "Submit negative quantity", expect: ["Validation error shown", "No record"] }], requirementIds: [] },
      { id: "flow_dash_search", title: "Search from dashboard", category: "happy", priority: "low", pages: ["/dashboard"], steps: [{ intent: "Search orders", expect: ["Results visible", "No error"] }], requirementIds: [] },
    ],
  };
}

test("coverage rules expose ten checks", () => {
  assert.equal(COVERAGE_RULES.length, 10);
  assert.ok(COVERAGE_RULES.some((r) => r.id === "happy-path-coverage" && r.severity === "blocking"));
});

test("passing plan scores high with no gaps", () => {
  const report = evaluatePlan({ plan: passingPlan(), siteMap: baseSiteMap(), prd: { requirements: [{ id: "REQ-1", text: "x", keywords: [] }] }, prompt: "" });
  assert.ok(report.score >= 0.75);
  assert.equal(report.gaps.length, 0);
  assert.equal(report.untestedRisks.length, 0);
  assert.equal(decideVerdict({ checklist: report.checklist.map((c) => ({ ...c, gaps: report.gaps.filter((g) => g.ruleId === c.ruleId) })), attempt: 1, maxReplans: 2 }), "pass");
});

test("each blocking rule fails when its surface is uncovered", () => {
  const siteMap = baseSiteMap();
  // happy-path-coverage
  const noHappy = { ...passingPlan(), flows: passingPlan().flows.filter((f) => !(f.category === "happy" && f.pages.includes("/cart"))) };
  assert.equal(evaluatePlan({ plan: noHappy, siteMap }).checklist.find((c) => c.ruleId === "happy-path-coverage").status, "fail");
  // error-state-per-form
  const noError = { ...passingPlan(), flows: passingPlan().flows.filter((f) => !(f.category === "error" && f.pages.includes("/cart"))) };
  assert.equal(evaluatePlan({ plan: noError, siteMap }).checklist.find((c) => c.ruleId === "error-state-per-form").status, "fail");
  // auth-negative
  const noAuth = { ...passingPlan(), flows: passingPlan().flows.filter((f) => !/invalid|unauthenticated/i.test(f.id)) };
  assert.equal(evaluatePlan({ plan: noAuth, siteMap }).checklist.find((c) => c.ruleId === "auth-negative").status, "fail");
  // assertion-density
  const thin = { ...passingPlan(), flows: [{ id: "x", category: "happy", pages: ["/login"], steps: [{ intent: "Hi", expect: [] }] }] };
  assert.equal(evaluatePlan({ plan: thin, siteMap }).checklist.find((c) => c.ruleId === "assertion-density").status, "fail");
  // category-mix
  const skewed = { ...passingPlan(), flows: passingPlan().flows.filter((f) => f.category === "happy") };
  assert.equal(evaluatePlan({ plan: skewed, siteMap }).checklist.find((c) => c.ruleId === "category-mix").status, "fail");
  // prompt-honored
  const promptFail = evaluatePlan({ plan: passingPlan(), siteMap, prompt: "zzzz-no-match" });
  assert.equal(promptFail.checklist.find((c) => c.ruleId === "prompt-honored").status, "fail");
});

test("advisory rules flag orphans, destructive and prd gaps", () => {
  const siteMap = baseSiteMap();
  const orphan = { ...passingPlan(), flows: passingPlan().flows.filter((f) => !f.pages.includes("/dashboard") || f.id === "flow_dash_happy") };
  const orphaned = { ...passingPlan(), flows: passingPlan().flows.filter((f) => !f.pages.includes("/dashboard")) };
  assert.equal(evaluatePlan({ plan: orphaned, siteMap }).checklist.find((c) => c.ruleId === "orphan-page").status, "fail");

  const risky = {
    ...passingPlan(),
    flows: [...passingPlan().flows, { id: "flow_delete", title: "Delete order", category: "happy", pages: ["/cart"], steps: [{ intent: "Delete", expect: ["Gone"] }] }],
  };
  assert.equal(evaluatePlan({ plan: risky, siteMap }).checklist.find((c) => c.ruleId === "destructive-guard").status, "fail");

  const prdFail = evaluatePlan({ plan: passingPlan(), siteMap, prd: { requirements: [{ id: "REQ-9", text: "promo", keywords: ["promo"] }] } });
  assert.equal(prdFail.checklist.find((c) => c.ruleId === "prd-coverage").status, "fail");

  const edgeFail = evaluatePlan({ plan: { ...passingPlan(), flows: passingPlan().flows.filter((f) => f.category !== "edge") }, siteMap });
  assert.equal(edgeFail.checklist.find((c) => c.ruleId === "edge-boundary").status, "fail");
  void orphan;
});

test("verdict replans fixable gaps and escalates otherwise", () => {
  const siteMap = baseSiteMap();
  const fixable = evaluatePlan({ plan: { ...passingPlan(), flows: passingPlan().flows.filter((f) => f.id !== "flow_cart_empty") }, siteMap });
  assert.equal(decideVerdict({ checklist: fixable.checklist.map((c) => ({ ...c, gaps: fixable.gaps.filter((g) => g.ruleId === c.ruleId) })), attempt: 1, maxReplans: 2 }), "replan");
  assert.equal(decideVerdict({ checklist: fixable.checklist.map((c) => ({ ...c, gaps: fixable.gaps.filter((g) => g.ruleId === c.ruleId) })), attempt: 2, maxReplans: 2 }), "escalate");

  const thin = { id: "x", flows: [{ id: "x", category: "happy", pages: [], steps: [{ intent: "Hi", expect: [] }] }] };
  const unfixable = evaluatePlan({ plan: thin, siteMap });
  assert.equal(decideVerdict({ checklist: unfixable.checklist.map((c) => ({ ...c, gaps: unfixable.gaps.filter((g) => g.ruleId === c.ruleId) })), attempt: 1, maxReplans: 2 }), "escalate");
});

test("scorePlan and renderGapsMarkdown handle edges", () => {
  assert.equal(scorePlan([]), 0);
  assert.equal(scorePlan([{ severity: "blocking", status: "pass" }, { severity: "advisory", status: "fail" }]), 0.75);
  const md = renderGapsMarkdown({ score: 0.62, gaps: [{ severity: "blocking", ruleId: "r", target: "/x", kind: "k", suggestion: { title: "T" } }], untestedRisks: [{ area: "/a", reason: "r" }] });
  assert.match(md, /Coverage gaps/);
  assert.match(md, /Untested risks/);
  assert.match(renderGapsMarkdown({}), /Coverage gaps/);
});
