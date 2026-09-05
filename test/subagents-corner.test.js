import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerBrief,
  normalizePlan,
  planWithAgent,
  renderSiteMapBrief,
  reviewDraft,
} from "../src/planner-agent.js";
import {
  classifyFailure,
  createExpectationGuard,
  normalizeRediscovery,
} from "../src/healing.js";
import { normalizeDesignComparison } from "../src/design.js";
import {
  createNativeWebExecutor,
  detectNativeCapability,
} from "../src/native-executor.js";
import { assertTargetAllowed } from "../src/orchestrator.js";

const siteMap = {
  origin: "http://127.0.0.1:3000",
  auth: { authenticated: false },
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

const draft = {
  openQuestions: ["confirmation text unverified"],
  flows: [{
    id: "checkout",
    title: "Checkout",
    category: "happy",
    priority: "critical",
    rationale: "money moves",
    pages: ["/checkout"],
    preconditions: ["authenticated"],
    steps: [{
      intent: "Pay",
      page: "/checkout",
      expect: [{ prose: "Confirmed", assert: { kind: "text", value: "Order confirmation" } }],
    }],
  }],
};

// P1/P2: no capability or throwing capability falls back honestly.
test("P1/P2 corner: missing or throwing planner degrades to deterministic", async () => {
  const none = await planWithAgent({ siteMap });
  assert.equal(none.source.planner, "deterministic");
  assert.match(none.source.fallbackReason, /no planner capability/);

  const broken = await planWithAgent({
    planner: async () => { throw new Error("sub-agent unavailable"); },
    siteMap,
  });
  assert.equal(broken.source.fellBack, true);
  assert.match(broken.source.fallbackReason, /sub-agent unavailable/);
});

// P3/P4: double rejection then fallback; empty plan never validates.
test("P3/P4 corner: invalid draft gets one repair, empty plan rejected", async () => {
  const seen = [];
  const plan = await planWithAgent({
    planner: async (req) => {
      seen.push(req);
      return { flows: [{ id: "x", title: "X", category: "happy", priority: "low", steps: [{ intent: "go", expect: [{ prose: "p", assert: { kind: "nope" } }] }] }] };
    },
    siteMap,
  });
  assert.equal(seen.length, 2);
  assert.match(seen[1].repair.validationIssues, /kind|enum/i);
  assert.equal(seen[1].repair.rejectedDraft.flows[0].id, "x");
  assert.match(plan.source.fallbackReason, /rejected after 2/);
  assert.equal(reviewDraft({ flows: [] }).ok, false);
  assert.equal(reviewDraft(null).ok, false);
});

// P5: selector smuggling / unknown predicate kind rejected before generation.
test("P5 corner: planner cannot smuggle selectors or invented predicates", () => {
  const smuggled = structuredClone(draft);
  smuggled.flows[0].steps[0].selector = "#pay";
  assert.equal(reviewDraft(smuggled).ok, false);
  const invented = structuredClone(draft);
  invented.flows[0].steps[0].expect[0].assert.kind = "vibes";
  assert.equal(reviewDraft(invented).ok, false);
});

// P6/P7/P8: brief honesty — anonymous, degraded, truncated.
test("P6/P7/P8 corner: brief marks anonymous, degraded, truncation", () => {
  assert.equal(JSON.parse(buildPlannerBrief({ siteMap })).session.authProvenance, "anonymous");
  assert.equal(JSON.parse(buildPlannerBrief({ siteMap: { ...siteMap, auth: { authenticated: true } } })).session.authProvenance, "authenticated");
  assert.equal(JSON.parse(buildPlannerBrief({ siteMap: { ...siteMap, degraded: true } })).session.degraded, true);
  assert.match(renderSiteMapBrief(siteMap, { maxChars: 10 }), /site map truncated/);
});

// P9/P10: id collision + traced lifecycle.
test("P9/P10 corner: colliding ids dedupe, lifecycle traced", async () => {
  const deduped = normalizePlan({ draft: { flows: [draft.flows[0], draft.flows[0]] }, siteMap });
  assert.notEqual(deduped.flows[0].id, deduped.flows[1].id);
  const events = [];
  await planWithAgent({
    planner: async () => draft,
    siteMap,
    emit: async (stage, type) => events.push(`${stage}:${type}`),
  });
  assert.ok(events.includes("plan:planner_started"));
  assert.ok(events.includes("plan:planner_completed"));
});

// H1/H2: equivalent found retries, non-equivalent stays failed.
test("H1/H2 corner: only explicit equivalence retries", () => {
  const failure = { stage: "action", status: "failed", explanation: "click missed" };
  const retry = classifyFailure({
    failure,
    rediscovery: normalizeRediscovery({ status: "found", equivalent: true, target: { summary: "Continue to payment" } }),
  });
  assert.equal(retry.decision, "retry_equivalent_target");
  const noHeal = classifyFailure({
    failure,
    rediscovery: normalizeRediscovery({ status: "found", equivalent: false }),
  });
  assert.notEqual(noHeal.decision, "retry_equivalent_target");
});

// H5/H6: absent capability (null) and blocked/ambiguous never pass.
test("H5/H6 corner: null or blocked rediscovery never becomes a pass", () => {
  const failure = { stage: "action", status: "failed", explanation: "missed" };
  const absent = classifyFailure({ failure, rediscovery: null });
  assert.notEqual(absent.decision, "retry_equivalent_target");
  const blocked = classifyFailure({
    failure,
    rediscovery: normalizeRediscovery({ status: "blocked", explanation: "no driver" }),
  });
  assert.notEqual(blocked.decision, "retry_equivalent_target");
  assert.equal(normalizeRediscovery(null).status, "ambiguous");
  assert.equal(normalizeRediscovery({ status: "nonsense" }).status, "ambiguous");
});

// H3 guard: expectations immutable during healing.
test("H3 corner: expectation guard freezes the contract", () => {
  const guard = createExpectationGuard(["Order confirmation is visible"]);
  assert.deepEqual(guard.expectations, ["Order confirmation is visible"]);
  assert.throws(() => { guard.expectations.push("new"); });
});

// D2/D3: design comparator blocks honestly on missing/invalid evidence.
test("D2/D3 corner: design without evidence or with garbage never passes", () => {
  const missing = normalizeDesignComparison({ status: "matched", findings: [] });
  assert.equal(missing.status, "matched");
  const regressionWithoutFinding = normalizeDesignComparison({ status: "regression", findings: [] });
  assert.equal(regressionWithoutFinding.status, "blocked");
  const garbage = normalizeDesignComparison({ status: "tastes-bad" });
  assert.equal(garbage.status, "blocked");
});

// E1/E2/E3: executor capability boundary.
test("E1/E2/E3 corner: kind mismatch, missing methods, absent executor block", async () => {
  const webOnDesktop = await detectNativeCapability(
    { type: "desktop" },
    createNativeWebExecutor({ act() {}, observe() {}, screenshot() {} }),
  );
  assert.equal(webOnDesktop.available, false);
  assert.match(webOnDesktop.explanation, /desktop/i);

  const missing = await detectNativeCapability(
    { type: "web" },
    createNativeWebExecutor({ act() {} }),
  );
  assert.equal(missing.available, false);
  assert.match(missing.explanation, /missing/i);

  const absent = await detectNativeCapability({ type: "web" }, undefined);
  assert.equal(absent.available, false);
  assert.match(absent.explanation, /No native.*executor was provided to this process/);
  assert.match(absent.explanation, /does not establish that the host capability is unavailable/);
});

// E6: remote targets require explicit opt-in.
test("E6 corner: remote orchestration target blocked without flag", () => {
  assert.throws(() => assertTargetAllowed("https://example.com"), /Remote targets require --allow-remote/);
  assert.doesNotThrow(() => assertTargetAllowed("https://example.com", { allowRemote: true }));
  assert.doesNotThrow(() => assertTargetAllowed("http://127.0.0.1:3000"));
});
