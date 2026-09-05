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
      { id: "flow_login_happy", title: "Sign in via /login", category: "happy", priority: "critical", pages: ["/login"], steps: [{ intent: "Sign in", expect: [{ prose: 'Dashboard visible', assert: { kind: 'text', value: 'Dashboard visible' } }, { prose: 'No error', assert: { kind: 'text', value: 'No error' } }] }], requirementIds: ["REQ-1"] },
      { id: "flow_cart_happy", title: "Submit form on /cart", category: "happy", priority: "high", pages: ["/cart"], steps: [{ intent: "Place order", expect: [{ prose: 'Confirmation visible', assert: { kind: 'text', value: 'Confirmation visible' } }, { prose: 'Only one order is created', assert: { kind: 'text', value: 'Only one order is created' } }] }], requirementIds: ["REQ-1"] },
      { id: "flow_dash_happy", title: "Open dashboard", category: "happy", priority: "medium", pages: ["/dashboard"], steps: [{ intent: "Open dashboard", expect: [{ prose: 'Dashboard visible', assert: { kind: 'text', value: 'Dashboard visible' } }, { prose: 'Stats shown', assert: { kind: 'text', value: 'Stats shown' } }] }], requirementIds: [] },
      { id: "flow_login_invalid_creds", title: "Reject invalid credentials", category: "error", priority: "critical", pages: ["/login"], steps: [{ intent: "Sign in with invalid credentials", expect: [{ prose: 'Error shown', assert: { kind: 'text', value: 'Error shown' } }, { prose: 'No session', assert: { kind: 'text', value: 'No session' } }] }], requirementIds: [] },
      { id: "flow_unauthenticated_redirect", title: "Redirect unauthenticated deep links", category: "error", priority: "high", pages: ["/dashboard"], steps: [{ intent: "Open protected", expect: [{ prose: 'Sign in required', assert: { kind: 'text', value: 'Sign in required' } }, { prose: 'No data', assert: { kind: 'text', value: 'No data' } }] }], requirementIds: [] },
      { id: "flow_cart_empty", title: "Reject empty card on /cart", category: "error", priority: "high", pages: ["/cart"], steps: [{ intent: "Submit blank", expect: [{ prose: 'Validation error', assert: { kind: 'text', value: 'Validation error' } }, { prose: 'No record', assert: { kind: 'text', value: 'No record' } }] }], requirementIds: [] },
      { id: "flow_cart_edge", title: "Guard double submission on /cart", category: "edge", priority: "medium", pages: ["/cart"], steps: [{ intent: "Submit twice", expect: [{ prose: 'Only one order is created', assert: { kind: 'text', value: 'Only one order is created' } }, { prose: 'Warning shown', assert: { kind: 'text', value: 'Warning shown' } }] }], requirementIds: [] },
      { id: "flow_cart_boundary", title: "Reject out-of-range quantity on /cart", category: "edge", priority: "medium", pages: ["/cart"], steps: [{ intent: "Submit negative quantity", expect: [{ prose: 'Validation error shown', assert: { kind: 'text', value: 'Validation error shown' } }, { prose: 'No record', assert: { kind: 'text', value: 'No record' } }] }], requirementIds: [] },
      { id: "flow_dash_search", title: "Search from dashboard", category: "happy", priority: "low", pages: ["/dashboard"], steps: [{ intent: "Search orders", expect: [{ prose: 'Results visible', assert: { kind: 'text', value: 'Results visible' } }, { prose: 'No error', assert: { kind: 'text', value: 'No error' } }] }], requirementIds: [] },
    ],
  };
}

test("coverage rules expose the twelve checks, and only outcome rules block", () => {
  assert.equal(COVERAGE_RULES.length, 12);
  assert.ok(COVERAGE_RULES.some((r) => r.id === "happy-path-coverage" && r.severity === "blocking"));
  assert.ok(COVERAGE_RULES.some((r) => r.id === "checkable-assertions" && r.severity === "blocking"));
  // Shape rules describe a plan from a distance and must never outvote it: a
  // planner that consolidates shallow flows into real journeys moves every
  // ratio while improving the plan.
  for (const id of ["category-mix", "journey-depth", "orphan-page"]) {
    assert.equal(COVERAGE_RULES.find((r) => r.id === id).severity, "advisory", `${id} must be advisory`);
  }
});

test("a plan whose expectations cannot be evaluated is not a passing plan", () => {
  // The core of the rework. Prose alone compiles to no assertion, so the suite
  // it generates cannot fail — worse than one that fails loudly.
  const prose = passingPlan();
  for (const flow of prose.flows) {
    for (const step of flow.steps) step.expect = step.expect.map((entry) => entry.prose);
  }
  const report = evaluatePlan({ plan: prose, siteMap: baseSiteMap() });
  const rule = report.checklist.find((c) => c.ruleId === "checkable-assertions");
  assert.equal(rule.status, "fail");
  assert.match(rule.detail, /0\/\d+ expectations carry a checkable predicate/);
  // Not auto-fixable: no rearrangement of flows invents an observable string,
  // so it escalates with the reason rather than burning replan attempts.
  const gap = report.gaps.find((g) => g.ruleId === "checkable-assertions");
  assert.equal(gap.autoFixable, false);
  assert.match(gap.hint, /observed in the crawl/);
});

test("a journey's step pages count as coverage", () => {
  // A consolidated flow names its pages on the steps, not on the flow. The
  // gate used to read flow.pages only, so a real journey read as uncovered.
  const journey = {
    id: "plan_j",
    flows: [{
      id: "flow_journey",
      title: "Cart to confirmation",
      category: "happy",
      priority: "critical",
      pages: [],
      steps: [
        { intent: "Open cart", page: "/cart", action: "navigate", expect: [{ prose: "Cart", assert: { kind: "text", value: "Cart" } }] },
        { intent: "Sign in", page: "/login", action: "submit", expect: [{ prose: "In", assert: { kind: "text", value: "In" } }] },
      ],
    }],
  };
  const report = evaluatePlan({ plan: journey, siteMap: baseSiteMap() });
  assert.equal(report.checklist.find((c) => c.ruleId === "happy-path-coverage").evidence.includes("/login"), false);
  assert.equal(report.checklist.find((c) => c.ruleId === "happy-path-coverage").evidence.includes("/cart"), false);
  assert.equal(report.checklist.find((c) => c.ruleId === "journey-depth").status, "pass");
});

test("coverage misses confined to pages the developer scoped out do not block", () => {
  const siteMap = baseSiteMap();
  const plan = passingPlan();
  // Drop every /dashboard flow, then scope the prompt away from it.
  plan.flows = plan.flows.filter((flow) => !flow.pages.includes("/dashboard"));
  const scoped = evaluatePlan({ plan, siteMap, prompt: "focus on cart and login" });
  const orphan = scoped.checklist.find((c) => c.ruleId === "orphan-page");
  assert.equal(orphan.status, "pass", "an out-of-scope page is reported, not counted against the plan");
  assert.match(orphan.detail, /outside the developer's stated scope/);
  assert.equal(scoped.untestedRisks.find((r) => r.area === "/dashboard").risk, "low");

  // With no prompt there is no declared scope, so the same miss still counts.
  const unscoped = evaluatePlan({ plan, siteMap });
  assert.equal(unscoped.checklist.find((c) => c.ruleId === "orphan-page").status, "fail");
});

test("prompt matching is generic, not a hardcoded topic table", () => {
  const siteMap = {
    origin: "http://127.0.0.1:4000",
    pages: [{ path: "/invoices", title: "Invoices", forms: [{ action: "/invoices", inputs: [{ name: "amount", type: "text" }] }], signals: {} }],
  };
  const plan = {
    id: "plan_i",
    flows: [
      { id: "flow_invoice_happy", title: "Create an invoice", category: "happy", priority: "high", pages: ["/invoices"], steps: [{ intent: "Create", expect: [{ prose: "Made", assert: { kind: "text", value: "Made" } }] }] },
      { id: "flow_invoice_error", title: "Reject a bad invoice", category: "error", priority: "high", pages: ["/invoices"], steps: [{ intent: "Reject", expect: [{ prose: "Bad", assert: { kind: "text", value: "Bad" } }] }] },
    ],
  };
  // "invoices" is not checkout or authentication, the only two topics the old
  // alias table knew about.
  assert.equal(evaluatePlan({ plan, siteMap, prompt: "focus on invoices" }).checklist.find((c) => c.ruleId === "prompt-honored").status, "pass");
});

test("passing plan scores high with no gaps", () => {
  const report = evaluatePlan({ plan: passingPlan(), siteMap: baseSiteMap(), prd: { requirements: [{ id: "REQ-1", text: "x", keywords: [] }] }, prompt: "" });
  assert.ok(report.score >= 0.75);
  assert.equal(report.gaps.filter((gap) => gap.severity === "blocking").length, 0);
  // This fixture is nine single-step flows, so journey-depth reports it — an
  // advisory finding that is true and must not block the run.
  assert.deepEqual(report.gaps.map((gap) => gap.ruleId), ["journey-depth"]);
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
  // assertion-presence: a step that observes something must say what
  const thin = { ...passingPlan(), flows: [{ id: "x", category: "happy", pages: ["/login"], steps: [{ intent: "Hi", expect: [] }] }] };
  assert.equal(evaluatePlan({ plan: thin, siteMap }).checklist.find((c) => c.ruleId === "assertion-presence").status, "fail");
  // ...but a step that only acts is exempt: filling a field is observable by
  // nothing, and the generator folds it into the step that asserts its outcome.
  const actionOnly = {
    ...passingPlan(),
    flows: [{
      id: "x",
      category: "happy",
      pages: ["/login"],
      steps: [
        { intent: "Fill the card", action: "fill", expect: [] },
        { intent: "Submit", action: "submit", expect: [{ prose: "Done", assert: { kind: "text", value: "Done" } }] },
      ],
    }],
  };
  assert.equal(evaluatePlan({ plan: actionOnly, siteMap }).checklist.find((c) => c.ruleId === "assertion-presence").status, "pass");
  // checkable-assertions
  const unverifiable = { ...passingPlan(), flows: [{ id: "x", category: "happy", pages: ["/login"], steps: [{ intent: "Hi", expect: [{ prose: "Something is visible" }] }] }] };
  assert.equal(evaluatePlan({ plan: unverifiable, siteMap }).checklist.find((c) => c.ruleId === "checkable-assertions").status, "fail");
  // prompt-honored, and it now names something the planner can act on
  const promptFail = evaluatePlan({ plan: passingPlan(), siteMap, prompt: "zzzz-no-match" });
  const promptRule = promptFail.checklist.find((c) => c.ruleId === "prompt-honored");
  assert.equal(promptRule.status, "fail");
  assert.ok(promptFail.gaps.some((g) => g.ruleId === "prompt-honored" && g.hint), "a blocking rule must name an actionable gap");
});

test("category-mix reports skew without blocking a consolidated plan", () => {
  const siteMap = baseSiteMap();
  const skewed = { ...passingPlan(), flows: passingPlan().flows.filter((f) => f.category === "happy") };
  const entry = evaluatePlan({ plan: skewed, siteMap }).checklist.find((c) => c.ruleId === "category-mix");
  assert.equal(entry.status, "fail");
  assert.equal(entry.severity, "advisory");
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
