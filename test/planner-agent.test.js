import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerBrief,
  normalizePlan,
  PLANNER_INSTRUCTIONS,
  planWithAgent,
  renderSiteMapBrief,
  reviewDraft,
} from "../src/planner-agent.js";

const siteMap = {
  origin: "http://127.0.0.1:1",
  auth: { authenticated: true },
  pages: [
    {
      path: "/login",
      status: 200,
      depth: 0,
      title: "Sign in",
      headings: [{ level: 1, text: "Customer sign in" }],
      links: [{ text: "Cart", href: "/cart" }],
      forms: [{
        action: "/login",
        method: "post",
        buttons: ["Sign in"],
        inputs: [
          { name: "username", type: "text", required: true },
          { name: "password", type: "password", required: true },
        ],
      }],
      signals: { auth: true },
    },
  ],
};

const validDraft = {
  notes: "Scoped to checkout.",
  openQuestions: ["what is the confirmation text?"],
  flows: [{
    id: "checkout",
    title: "Checkout",
    category: "happy",
    priority: "critical",
    rationale: "money moves here",
    pages: ["/checkout"],
    preconditions: ["authenticated"],
    requirementIds: ["REQ-1"],
    steps: [{
      intent: "Pay",
      page: "/checkout",
      action: "submit",
      inputs: [{ name: "card", value: "4111", sensitive: false }],
      expect: [{ prose: "Confirmed", assert: { kind: "text", value: "Order confirmation" } }],
    }],
  }],
};

test("the brief carries structure and observable strings, never invented ones", () => {
  const brief = buildPlannerBrief({ siteMap, prompt: "focus on login" });
  assert.match(brief, /TARGET: http:\/\/127\.0\.0\.1:1/);
  assert.match(brief, /CRAWL SESSION: authenticated/);
  assert.match(brief, /h1 "Customer sign in"/);
  assert.match(brief, /inputs=\[username:text required, password:password required\]/);
  assert.match(brief, /focus on login/);

  // A degraded crawl must say so rather than letting the planner assume the
  // structure is complete.
  assert.match(buildPlannerBrief({ siteMap: { ...siteMap, degraded: true } }), /WARNING: the crawl looks degraded/);
  assert.match(
    buildPlannerBrief({ siteMap: { ...siteMap, auth: { authenticated: false } } }),
    /CRAWL SESSION: anonymous/,
  );

  // Truncation must be visible, not silent.
  assert.match(renderSiteMapBrief(siteMap, { maxChars: 40 }), /site map truncated/);
});

test("the instructions forbid asserting the prose back at the page", () => {
  assert.match(PLANNER_INSTRUCTIONS, /NEVER copy the prose into the assert value/);
  assert.match(PLANNER_INSTRUCTIONS, /plan-draft\.schema\.json/);
});

test("a draft is rejected unless it satisfies the published contract", () => {
  assert.equal(reviewDraft(validDraft).ok, true);
  assert.equal(reviewDraft(null).ok, false);
  assert.match(reviewDraft({ flows: [] }).reason, /flows/);
  // A predicate kind nobody implements must not reach the generator.
  const invented = structuredClone(validDraft);
  invented.flows[0].steps[0].expect[0].assert.kind = "vibes";
  assert.equal(reviewDraft(invented).ok, false);
  // Extra keys are a sign the planner improvised the contract.
  const extra = structuredClone(validDraft);
  extra.flows[0].steps[0].selector = "#pay";
  assert.equal(reviewDraft(extra).ok, false);
});

test("drafts normalize into the internal plan shape", () => {
  const plan = normalizePlan({ draft: validDraft, siteMap, source: { planner: "agent", fellBack: false } });
  assert.equal(plan.flows[0].id, "flow_checkout");
  assert.deepEqual(plan.coverageClaims, { happy: 1, edge: 0, error: 0 });
  assert.deepEqual(plan.flows[0].steps[0].expect[0].assert, { kind: "text", value: "Order confirmation" });
  assert.deepEqual(plan.openQuestions, ["what is the confirmation text?"]);
  assert.equal(plan.notes, "Scoped to checkout.");

  // Two flows that slug to the same id must stay addressable.
  const collide = { flows: [validDraft.flows[0], { ...validDraft.flows[0] }] };
  const deduped = normalizePlan({ draft: collide, siteMap });
  assert.notEqual(deduped.flows[0].id, deduped.flows[1].id);
});

test("a planner sub-agent produces the plan, and its draft is validated first", async () => {
  const seen = [];
  const plan = await planWithAgent({
    planner: async (request) => {
      seen.push(request);
      return validDraft;
    },
    siteMap,
    prompt: "focus on checkout",
  });
  assert.equal(plan.source.planner, "agent");
  assert.equal(plan.source.fellBack, false);
  assert.equal(plan.flows.length, 1);
  // The capability is handed the contract, not left to guess it.
  assert.equal(seen[0].schema, "plan-draft.schema.json");
  assert.match(seen[0].instructions, /senior QA engineer/);
  assert.match(seen[0].brief, /focus on checkout/);
});

test("an invalid draft earns one round of feedback, then falls back honestly", async () => {
  const requests = [];
  const plan = await planWithAgent({
    planner: async (request) => {
      requests.push(request);
      return { flows: [{ id: "x", title: "X", category: "happy", priority: "low", steps: [{ intent: "go", expect: [{ prose: "p", assert: { kind: "nope" } }] }] }] };
    },
    siteMap,
  });
  assert.equal(requests.length, 2, "a rejected draft is sent back once with the reason");
  assert.match(requests[1].feedback, /rejected/i);
  assert.equal(plan.source.planner, "deterministic");
  assert.equal(plan.source.fellBack, true);
  assert.match(plan.source.fallbackReason, /rejected after 2/);
  assert.ok(plan.flows.length > 0, "a fallback still produces a usable plan");
});

test("no planner, or one that throws, degrades to the deterministic plan", async () => {
  const none = await planWithAgent({ siteMap });
  assert.equal(none.source.planner, "deterministic");
  assert.match(none.source.fallbackReason, /no planner capability/);

  const broken = await planWithAgent({
    planner: async () => { throw new Error("sub-agent unavailable"); },
    siteMap,
  });
  assert.equal(broken.source.fellBack, true);
  assert.match(broken.source.fallbackReason, /sub-agent unavailable/);
  assert.ok(broken.flows.length > 0);
});

test("planner lifecycle is traced so the sub-agent is legible in the artifact", async () => {
  const events = [];
  await planWithAgent({
    planner: async () => validDraft,
    siteMap,
    emit: async (stage, type, detail) => events.push(`${stage}:${type}:${detail?.message ?? ""}`),
  });
  assert.ok(events.some((entry) => entry.startsWith("plan:planner_started")));
  assert.ok(events.some((entry) => entry.startsWith("plan:planner_completed")));
});
