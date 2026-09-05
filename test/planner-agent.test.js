import test from "node:test";
import assert from "node:assert/strict";
import {
  assignRequirementsToPartitions,
  buildPlannerBrief,
  mergePlannerPlans,
  normalizePlan,
  partitionPlannerEvidence,
  PLAN_DRAFT_WIRE_SCHEMA,
  PLANNER_INSTRUCTIONS,
  planWithAgent,
  planWithParallelAgents,
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
      inputs: [{ name: "card", value: "${QA_TEST_CARD}", sensitive: true }],
      expect: [{ prose: "Confirmed", assert: { kind: "text", value: "Order confirmation" } }],
    }],
  }],
};

test("the brief carries structure and observable strings, never invented ones", () => {
  const brief = buildPlannerBrief({ siteMap, prompt: "focus on login" });
  const packet = JSON.parse(brief);
  assert.equal(packet.session.target, "http://127.0.0.1:1");
  assert.equal(packet.session.authProvenance, "authenticated");
  assert.deepEqual(packet.pages[0].headings, [{ level: 1, text: "Customer sign in" }]);
  assert.deepEqual(packet.pages[0].forms[0].inputs.map(({ name, required }) => ({ name, required })), [{ name: "username", required: true }, { name: "password", required: true }]);
  assert.equal(packet.objective.inScope, "focus on login");
  assert.match(packet.evidenceBoundary, /untrusted data/);

  // A degraded crawl must say so rather than letting the planner assume the
  // structure is complete.
  assert.equal(JSON.parse(buildPlannerBrief({ siteMap: { ...siteMap, degraded: true } })).session.degraded, true);
  assert.equal(JSON.parse(buildPlannerBrief({ siteMap: { ...siteMap, auth: { authenticated: false } } })).session.authProvenance, "anonymous");

  // Truncation must be visible, not silent.
  assert.match(renderSiteMapBrief(siteMap, { maxChars: 40 }), /site map truncated/);
  const oversized = buildPlannerBrief({
    siteMap: { ...siteMap, pages: Array.from({ length: 100 }, (_, index) => ({ ...siteMap.pages[0], path: `/page-${index}`, title: "x".repeat(5_000) })) },
    prompt: "p".repeat(100_000),
    prd: { requirements: Array.from({ length: 100 }, (_, index) => ({ id: `REQ-${index}`, text: "r".repeat(5_000) })) },
    partition: { id: "oversized", pages: Array.from({ length: 100 }, (_, index) => ({ ...siteMap.pages[0], path: `/page-${index}`, title: "x".repeat(5_000) })), ownedRoutes: Array.from({ length: 100 }, () => `/${"r".repeat(500)}`), integrationEdges: Array.from({ length: 100 }, () => ({ from: `/${"f".repeat(500)}`, to: `/${"t".repeat(500)}`, label: "l".repeat(500) })) },
  });
  assert.ok(oversized.length <= 60_000);
  assert.equal(JSON.parse(oversized).truncated, true);
});

test("the instructions forbid asserting the prose back at the page", () => {
  assert.match(PLANNER_INSTRUCTIONS, /Never copy the prose into the assert value/i);
  assert.deepEqual(PLAN_DRAFT_WIRE_SCHEMA.predicate.count.required, ["kind", "selector", "count"]);
  assert.doesNotMatch(PLANNER_INSTRUCTIONS, /every form|happy path is a failed plan/i);
  assert.match(PLANNER_INSTRUCTIONS, /content accuracy, and cross-view consistency/i);
  assert.match(PLANNER_INSTRUCTIONS, /explicit requirements into binary checks/i);
  assert.match(PLANNER_INSTRUCTIONS, /destructive-action guards/i);
});

test("a draft is rejected unless it satisfies the published contract", () => {
  assert.equal(reviewDraft(validDraft, { valueReferences: ["${QA_TEST_CARD}"] }).ok, true);
  assert.equal(reviewDraft(null).ok, false);
  assert.match(reviewDraft({ flows: [] }).reason, /flows/);
  // A predicate kind nobody implements must not reach the generator.
  const invented = structuredClone(validDraft);
  invented.flows[0].steps[0].expect[0].assert.kind = "vibes";
  assert.equal(reviewDraft(invented).ok, false);
  const incomplete = structuredClone(validDraft);
  delete incomplete.flows[0].steps[0].expect[0].assert.value;
  assert.equal(reviewDraft(incomplete).ok, false, "a predicate cannot count toward coverage without the field its kind requires");
  // Extra keys are a sign the planner improvised the contract.
  const extra = structuredClone(validDraft);
  extra.flows[0].steps[0].selector = "#pay";
  assert.equal(reviewDraft(extra).ok, false);
  assert.equal(reviewDraft({ flows: Array.from({ length: 101 }, () => validDraft.flows[0]) }).ok, false, "planner output fan-out is bounded by schema");
  const leaked = structuredClone(validDraft);
  leaked.flows[0].steps[0].inputs[0].value = "4242424242424242";
  assert.match(reviewDraft(leaked).reason, /sensitive inputs require a value reference/);
  assert.equal(reviewDraft(validDraft, { valueReferences: ["${QA_OTHER_CARD}"] }).ok, false);
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
    valueReferences: ["${QA_TEST_CARD}"],
  });
  assert.equal(plan.source.planner, "agent");
  assert.equal(plan.source.fellBack, false);
  assert.equal(plan.flows.length, 1);
  // The capability is handed the contract, not left to guess it.
  assert.equal(seen[0].schemaId, "plan-draft.schema.json");
  assert.deepEqual(seen[0].schema, PLAN_DRAFT_WIRE_SCHEMA);
  assert.match(seen[0].instructions, /evidence-grounded/);
  assert.match(seen[0].brief, /focus on checkout/);
  assert.equal(seen[0].siteMap, undefined, "raw crawl is not duplicated beside the brief");
  assert.equal(seen[0].prompt, undefined, "raw objective is not duplicated beside the brief");
  assert.match(seen[0].evidenceRefs[0], /^route:[a-f0-9]{12}$/);
  assert.doesNotMatch(seen[0].evidenceRefs.join(" "), /login/, "untrusted route text stays inside the bounded brief");
  assert.deepEqual(JSON.parse(seen[0].brief).valueReferences, ["${QA_TEST_CARD}"]);
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
  assert.match(requests[1].repair.validationIssues, /kind|enum/i);
  assert.equal(requests[1].repair.rejectedDraft.flows[0].steps[0].expect[0].assert.kind, "nope");
  assert.equal(plan.source.planner, "deterministic");
  assert.equal(plan.source.fellBack, true);
  assert.match(plan.source.fallbackReason, /rejected after 2/);
  assert.ok(plan.flows.length > 0, "a fallback still produces a usable plan");
});

test("repair context bounds an oversized rejected draft", async () => {
  const requests = [];
  const huge = { flows: Array.from({ length: 101 }, (_, index) => ({ ...validDraft.flows[0], id: `flow-${index}`, rationale: "x".repeat(1_000) })) };
  const plan = await planWithAgent({
    siteMap,
    attempts: 2,
    valueReferences: ["${QA_TEST_CARD}"],
    planner: async (request) => {
      requests.push(request);
      return requests.length === 1 ? huge : validDraft;
    },
  });
  assert.equal(plan.source.fellBack, false);
  assert.equal(requests[1].repair.rejectedDraft.truncated, true);
  assert.ok(JSON.stringify(requests[1].repair.rejectedDraft).length <= 20_000);
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
    valueReferences: ["${QA_TEST_CARD}"],
    emit: async (stage, type, detail) => events.push(`${stage}:${type}:${detail?.message ?? ""}`),
  });
  assert.ok(events.some((entry) => entry.startsWith("plan:planner_started")));
  assert.ok(events.some((entry) => entry.startsWith("plan:planner_completed")));
});

test("route evidence partitions fan out concurrently and merge deterministically", async () => {
  const expanded = {
    ...siteMap,
    pages: ["/account", "/catalog", "/support"].map((page, index) => ({
      ...siteMap.pages[0],
      path: page,
      title: `Page ${index + 1}`,
      links: [],
    })),
  };
  const partitions = partitionPlannerEvidence(expanded, { maxPartitions: 3 });
  assert.equal(partitions.length, 3);
  assert.equal(new Set(partitions.flatMap((partition) => partition.ownedRoutes)).size, 3);
  const assigned = assignRequirementsToPartitions(partitions, { requirements: [
    { id: "REQ-ACCOUNT", text: "Account behavior", keywords: ["account"] },
    { id: "REQ-CATALOG", text: "Catalog behavior", keywords: ["catalog"] },
    { id: "REQ-UNKNOWN", text: "A behavior absent from evidence", keywords: ["unobserved"] },
  ] });
  assert.equal(assigned.flatMap((partition) => partition.requirements).length, 2);
  assert.equal(new Set(assigned.flatMap((partition) => partition.requirements.map((requirement) => requirement.id))).size, 2);

  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const briefs = [];
  const planner = async (request) => {
    briefs.push(JSON.parse(request.brief));
    arrivals += 1;
    if (arrivals === 3) release();
    await gate;
    return {
      flows: [{
        id: request.taskId,
        title: request.taskId,
        category: "happy",
        priority: "medium",
        pages: [JSON.parse(request.brief).pages[0].path],
        steps: [{ intent: `Inspect ${request.taskId}`, expect: [{ prose: "Page is visible" }] }],
      }],
    };
  };
  const plan = await planWithParallelAgents({
    planner,
    siteMap: expanded,
    maxWorkers: 100,
    prd: { requirements: [{ id: "REQ-ACCOUNT", text: "Account behavior", keywords: ["account"] }] },
  });
  assert.equal(arrivals, 3);
  assert.equal(plan.flows.length, 3);
  assert.equal(plan.source.planner, "agent");
  assert.equal(briefs.flatMap((brief) => brief.requirements).length, 1, "a relevant PRD clause is not repeated into every worker packet");

  const deduped = mergePlannerPlans({ plans: [plan, plan], siteMap: expanded });
  assert.equal(deduped.flows.length, 3);
});
