import assert from "node:assert/strict";
import test from "node:test";
import { buildTestPlan, parsePrd, replan, renderTestPlanMarkdown } from "../src/planner.js";
import { CART_HTML, HOME_HTML, LOGIN_HTML } from "../test-support/fake-fetch.js";
import { parseHtml } from "../src/planner.js";

function siteMap() {
  return {
    origin: "http://127.0.0.1:4000",
    pages: [
      { path: "/login", ...parseHtml(LOGIN_HTML) },
      { path: "/", ...parseHtml(HOME_HTML) },
      { path: "/cart", ...parseHtml(CART_HTML) },
    ],
  };
}

test("parsePrd extracts requirements and keywords", () => {
  assert.deepEqual(parsePrd("").requirements, []);
  assert.deepEqual(parsePrd(null).requirements, []);
  const prd = parsePrd("- REQ-1 Users can checkout with saved card\n- promo codes apply at checkout");
  assert.equal(prd.requirements.length, 2);
  assert.equal(prd.requirements[0].id, "REQ-1");
  assert.equal(prd.requirements[1].id, "REQ-2");
});

test("buildTestPlan covers login negative, form errors, list, numeric and payment risks", () => {
  const plan = buildTestPlan({ siteMap: siteMap(), prompt: "focus on cart", prd: parsePrd("REQ-1 checkout with saved card"), now: () => new Date("2026-09-04T10:00:00.000Z") });
  assert.ok(plan.flows.some((f) => f.id.includes("invalid-creds")));
  // Session-isolation flows are cut (single-context runs cannot isolate
  // sessions) and tracked as an open question instead of failing silently.
  assert.ok(!plan.flows.some((f) => f.id.includes("unauthenticated-redirect")));
  assert.ok(plan.openQuestions.some((q) => /session-isolation/i.test(q)));
  assert.ok(plan.flows.some((f) => f.title.includes("empty")));
  assert.ok(plan.flows.some((f) => f.title.includes("empty state")));
  assert.ok(plan.flows.some((f) => f.title.includes("out-of-range")));
  assert.ok(plan.flows.some((f) => f.title.includes("double submission")));
  assert.ok(plan.coverageClaims.happy >= 2);
  const checkout = plan.flows.find((f) => f.id.includes("cart-form-0-happy"));
  assert.equal(checkout.priority, "critical");
  // Happy intents derive from the form's own submit label, not a generic template.
  // The first step is the journey open-step (observed link text); the action is last.
  assert.equal(checkout.steps[0].intent, "Cart");
  assert.equal(checkout.steps.at(-1).intent, "Place order");
  const paymentGuard = plan.flows.find((f) => f.title.includes("double submission"));
  assert.ok(paymentGuard.requirementIds.includes("REQ-1"));
});

test("planner attaches predicates from crawled text, never invented copy", () => {
  const plan = buildTestPlan({ siteMap: siteMap(), now: () => new Date("2026-09-04T10:00:00.000Z") });
  // No flow-level marker fields: test-plan.schema.json forbids them.
  for (const flow of plan.flows) {
    assert.ok(!("loginHappy" in flow) && !("needsCard" in flow));
  }
  // Observed headings produce text predicates; unknown outcomes stay bare.
  const cartHappy = plan.flows.find((f) => f.id.includes("cart-form-0-happy"));
  const action = cartHappy.steps.at(-1);
  const confirmation = action.expect.find((e) => typeof e === "object" && e.prose.includes("Order confirmation"));
  assert.ok(!confirmation, "confirmation copy is not crawled on this fixture, so no predicate is fabricated");
  const noError = action.expect.find((e) => typeof e === "object" && e.prose.includes("No error"));
  assert.deepEqual(noError?.assert?.kind, "absent_text");
  // Journey open steps carry heading predicates from the linked page.
  const open = cartHappy.steps[0];
  assert.ok(typeof open.expect[0] === "object" && open.expect[0].assert?.kind === "text");
});

test("buildTestPlan rejects empty site maps and dedupes flows", () => {
  assert.throws(() => buildTestPlan({ siteMap: { pages: [] } }), /empty site map/);
  const plan = buildTestPlan({ siteMap: siteMap(), now: () => new Date("2026-09-04T10:00:00.000Z") });
  const ids = plan.flows.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("replan merges gap suggestions once and bumps attempt", () => {
  const plan = buildTestPlan({ siteMap: siteMap(), now: () => new Date("2026-09-04T10:00:00.000Z") });
  const gaps = { gaps: [{ target: "/checkout", suggestion: { id: "flow_new", title: "New", steps: [] } }, { suggestion: null }] };
  const next = replan({ plan, gaps, now: () => new Date("2026-09-04T10:01:00.000Z") });
  assert.equal(next.attempt, 2);
  assert.ok(next.flows.some((f) => f.id === "flow_new"));
  const again = replan({ plan: next, gaps, now: () => new Date("2026-09-04T10:02:00.000Z") });
  assert.equal(again.flows.filter((f) => f.id === "flow_new").length, 1);
});

test("renderTestPlanMarkdown lists flows and open questions", () => {
  const plan = buildTestPlan({ siteMap: { origin: "http://x", pages: [{ path: "/", ...parseHtml("<h1>Hi</h1>") }] }, now: () => new Date("2026-09-04T10:00:00.000Z") });
  const md = renderTestPlanMarkdown(plan);
  assert.match(md, /# Test plan/);
  assert.match(md, /## Flows/);
});
