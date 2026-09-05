// The gate scores what determines whether the generated suite can actually
// pass, not what the plan looks like from a distance. Two principles:
//
//   1. A rule may only block when it can name an actionable gap. A blocking
//      failure with no gap is a dead end — decideVerdict escalates and the
//      replan loop can never fire, which is why replan was never observed.
//   2. Shape rules (category ratios, page counts) are advisory. A planner that
//      consolidates eleven shallow flows into five real journeys is producing a
//      better plan, and a ratio rule must not outvote that.
export const COVERAGE_RULES = Object.freeze([
  { id: "happy-path-coverage", severity: "blocking" },
  { id: "error-state-per-form", severity: "blocking" },
  { id: "auth-negative", severity: "blocking" },
  { id: "assertion-presence", severity: "blocking" },
  { id: "checkable-assertions", severity: "blocking" },
  { id: "prompt-honored", severity: "blocking" },
  { id: "category-mix", severity: "advisory" },
  { id: "journey-depth", severity: "advisory" },
  { id: "edge-boundary", severity: "advisory" },
  { id: "orphan-page", severity: "advisory" },
  { id: "destructive-guard", severity: "advisory" },
  { id: "prd-coverage", severity: "advisory" },
]);

const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "any", "all", "focus", "test", "testing", "please", "make", "sure", "flows", "flow", "app", "application", "path", "paths"]);

function promptKeywords(prompt) {
  return [...new Set(String(prompt ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
}

function promptHits(text, prompt) {
  if (!prompt) return false;
  const hay = String(text ?? "").toLowerCase();
  // Match the developer's own words against the plan's own words. The previous
  // implementation hardcoded aliases for "checkout" and "authentication" — the
  // two words in the demo command — so every other prompt scored zero.
  return promptKeywords(prompt).some((keyword) => hay.includes(keyword) || keyword.includes(hay.replace(/^\//, "")));
}

/** Every page a flow touches, including the ones only its steps name. */
function pagesTouched(flow) {
  const pages = new Set(flow?.pages ?? []);
  for (const step of flow?.steps ?? []) {
    if (step.page) pages.add(step.page);
  }
  return pages;
}

function planCoversPage(plan, path, predicate = () => true) {
  return (plan?.flows ?? []).some((flow) => predicate(flow) && pagesTouched(flow).has(path));
}

/**
 * A page the developer deliberately scoped out is not a coverage failure.
 * Missing it stays visible as advisory rather than blocking the run — the gate
 * must not contradict the prompt the planner was told to honour.
 */
function scopeFor(prompt, page) {
  if (!prompt) return "blocking";
  const text = `${page.path} ${page.title ?? ""} ${(page.headings ?? []).map((heading) => heading.text).join(" ")}`;
  return promptHits(text, prompt) ? "blocking" : "advisory";
}

/** A step that only acts — fill, navigate, click — has nothing to observe yet. */
function isActionOnlyStep(step) {
  return (step.expect ?? []).length === 0 && ["navigate", "click", "fill", "submit"].includes(step.action);
}

function expectationsOf(plan) {
  return (plan?.flows ?? []).flatMap((flow) => (flow.steps ?? []).flatMap((step) => step.expect ?? []));
}

function hasPredicate(expectation) {
  return Boolean(expectation && typeof expectation === "object" && expectation.assert && expectation.assert.kind);
}

/** An expectation is a bare string (deterministic planner) or { prose, assert }. */
function expectationText(expectation) {
  return typeof expectation === "string" ? expectation : expectation?.prose ?? "";
}

function formPages(siteMap) {
  return (siteMap?.pages ?? []).filter((page) => (page.forms ?? []).length > 0);
}

function submittableFormPages(siteMap) {
  // Button-only forms (zero inputs) have no invalid-input error state, so the
  // error-state rule exempts them. Must match planner.js, which only emits
  // invalid-submission probes for forms with at least one input.
  return formPages(siteMap).filter((page) => (page.forms ?? []).some((form) => (form.inputs ?? []).length > 0));
}

function checkHappyPath({ plan, siteMap, prompt }) {
  if (formPages(siteMap).length === 0) return { status: "skipped", detail: "No form surface discovered", evidence: [] };
  const missing = formPages(siteMap).filter((page) => !planCoversPage(plan, page.path, (flow) => flow.category === "happy"));
  if (missing.length === 0) return { status: "pass", detail: "Every form page has a happy flow", evidence: [] };
  const severity = missing.every((page) => scopeFor(prompt, page) === "advisory") ? "advisory" : "blocking";
  return {
    status: "fail",
    severity,
    detail: `${missing.length} form page(s) have no happy flow${severity === "advisory" ? " (all outside the developer's stated scope)" : ""}`,
    evidence: missing.map((page) => page.path),
    gaps: missing.map((page, index) => ({
      id: `gap_happy_${index}`,
      ruleId: "happy-path-coverage",
      kind: "missing_flow",
      severity: scopeFor(prompt, page),
      target: page.path,
      autoFixable: true,
      suggestion: {
        id: `flow_${page.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}-happy`,
        title: `Complete happy path on ${page.path}`,
        category: "happy",
        priority: "high",
        pages: [page.path],
        steps: [{ intent: `Complete the primary action on ${page.path}`, expect: ["The expected outcome is visible"] }],
      },
    })),
  };
}

function checkErrorPerForm({ plan, siteMap, prompt }) {
  if (submittableFormPages(siteMap).length === 0) return { status: "skipped", detail: "No submittable form surface discovered", evidence: [] };
  const missing = submittableFormPages(siteMap).filter((page) => !planCoversPage(plan, page.path, (flow) => flow.category === "error"));
  if (missing.length === 0) return { status: "pass", detail: "Every form has an error flow", evidence: [] };
  const severity = missing.every((page) => scopeFor(prompt, page) === "advisory") ? "advisory" : "blocking";
  return {
    status: "fail",
    severity,
    detail: `${missing.length} of ${submittableFormPages(siteMap).length} forms have no error-state flow${severity === "advisory" ? " (all outside the developer's stated scope)" : ""}`,
    evidence: missing.map((page) => page.path),
    gaps: missing.map((page, index) => ({
      id: `gap_error_${index}`,
      ruleId: "error-state-per-form",
      kind: "missing_flow",
      severity: scopeFor(prompt, page),
      target: page.path,
      autoFixable: true,
      suggestion: {
        id: `flow_${page.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}-empty`,
        title: `Reject empty submission on ${page.path}`,
        category: "error",
        priority: "high",
        pages: [page.path],
        steps: [{ intent: "Submit leaving required fields blank", expect: ["A validation error is shown", "No record is created"] }],
      },
    })),
  };
}

function checkAuthNegative({ plan, siteMap }) {
  const hasLogin = (siteMap?.pages ?? []).some((page) => (page.forms ?? []).some((form) => (form.inputs ?? []).some((input) => input.type === "password")));
  if (!hasLogin) return { status: "skipped", detail: "No login surface discovered", evidence: [] };
  const flows = plan.flows ?? [];
  const hasInvalid = flows.some((flow) => /invalid credential|invalid-cred/i.test(`${flow.title} ${flow.id}`));
  const hasRedirect = flows.some((flow) => /unauthenticated|redirect/i.test(`${flow.title} ${flow.id}`));
  const missing = [];
  if (!hasInvalid) missing.push("invalid-credential flow");
  if (!hasRedirect) missing.push("unauthenticated-redirect flow");
  if (missing.length === 0) return { status: "pass", detail: "Negative auth flows present", evidence: [] };
  return {
    status: "fail",
    detail: `Login exists but missing: ${missing.join(", ")}`,
    evidence: missing,
    gaps: missing.map((kind, index) => ({
      id: `gap_auth_${index}`,
      ruleId: "auth-negative",
      kind: "missing_flow",
      severity: "blocking",
      target: "/login",
      autoFixable: true,
      suggestion: kind.includes("invalid")
        ? { id: "flow_login_invalid_creds", title: "Reject invalid credentials", category: "error", priority: "critical", pages: ["/login"], steps: [{ intent: "Sign in with invalid credentials", expect: ["An error message is shown"] }] }
        : { id: "flow_unauthenticated_redirect", title: "Redirect unauthenticated deep links to login", category: "error", priority: "high", pages: ["/dashboard"], steps: [{ intent: "Open a protected page without signing in", expect: ["Sign in is required"] }] },
    })),
  };
}

/**
 * Every step that observes something must say what. A step that only acts —
 * fill the card, open the page — is exempt: it is honest for it to assert
 * nothing, and the generator folds it into the step that asserts its outcome.
 * The previous rule also demanded two expectations per flow, which scored a
 * precise single assertion as "thin".
 */
function checkAssertionPresence({ plan }) {
  const flows = plan.flows ?? [];
  if (flows.length === 0) {
    return {
      status: "fail",
      detail: "No flows to assert",
      evidence: [],
      gaps: [{ id: "gap_assert_0", ruleId: "assertion-presence", kind: "missing_assertion", severity: "blocking", target: "", autoFixable: false }],
    };
  }
  const silent = flows.filter((flow) => {
    const steps = flow.steps ?? [];
    const observing = steps.filter((step) => !isActionOnlyStep(step));
    return observing.length === 0 || observing.some((step) => (step.expect ?? []).length === 0);
  });
  if (silent.length === 0) return { status: "pass", detail: `${flows.length} flow(s) declare what to observe`, evidence: [] };
  return {
    status: "fail",
    detail: `${silent.length} flow(s) contain a step that observes nothing`,
    evidence: silent.map((flow) => flow.id),
    gaps: silent.map((flow) => ({
      id: `gap_assert_${flow.id}`,
      ruleId: "assertion-presence",
      kind: "missing_assertion",
      severity: "blocking",
      target: [...pagesTouched(flow)][0] ?? "",
      autoFixable: false,
      hint: `Flow ${flow.id} has a step with no expectation. Either declare what should be observable, or mark the step as an action (navigate/click/fill/submit).`,
    })),
  };
}

/**
 * The rule that decides whether the suite can pass at all.
 *
 * An expectation carrying only prose compiles to no assertion — the generator
 * emits `// UNVERIFIED` rather than asserting the sentence back at the page.
 * A plan of nothing but prose therefore produces a suite that cannot fail,
 * which is worse than one that fails loudly. This is not auto-fixable: no
 * rearrangement of flows invents an observable string, so it escalates with
 * the reason instead of burning replan attempts.
 */
function checkCheckableAssertions({ plan }) {
  const expectations = expectationsOf(plan);
  if (expectations.length === 0) return { status: "skipped", detail: "No expectations to check", evidence: [] };
  const checkable = expectations.filter(hasPredicate);
  const ratio = checkable.length / expectations.length;
  const detail = `${checkable.length}/${expectations.length} expectations carry a checkable predicate`;
  if (ratio >= 0.8) return { status: "pass", detail, evidence: [] };
  const bare = (plan.flows ?? [])
    .filter((flow) => (flow.steps ?? []).some((step) => (step.expect ?? []).some((expectation) => !hasPredicate(expectation))))
    .map((flow) => flow.id);
  return {
    status: "fail",
    detail,
    evidence: bare,
    gaps: [{
      id: "gap_checkable_0",
      ruleId: "checkable-assertions",
      kind: "unverifiable_assertion",
      severity: "blocking",
      target: bare[0] ?? "",
      autoFixable: false,
      hint: "Expectations need a machine-checkable predicate whose value is text observed in the crawl. Where the observable text is genuinely unknown, use url_contains or record it in openQuestions — do not invent page copy.",
    }],
  };
}

/**
 * Advisory. Ratios describe a plan's shape, and shape is a weak proxy: a
 * planner that folds eleven shallow flows into five real journeys shifts every
 * ratio while improving the plan. It reports, it does not block.
 */
function checkCategoryMix({ plan }) {
  const flows = plan.flows ?? [];
  if (flows.length === 0) {
    return {
      status: "fail",
      detail: "No flows",
      evidence: [],
      gaps: [{ id: "gap_mix_0", ruleId: "category-mix", kind: "missing_flow", severity: "advisory", target: "", autoFixable: false, hint: "The plan contains no flows at all." }],
    };
  }
  const share = (category) => flows.filter((flow) => flow.category === category).length / flows.length;
  const problems = [];
  if (share("happy") < 0.2) problems.push(`happy ${Math.round(share("happy") * 100)}% < 20%`);
  if (share("error") < 0.2) problems.push(`error ${Math.round(share("error") * 100)}% < 20%`);
  if (share("edge") + share("error") === 0) problems.push("no error or edge coverage at all");
  if (problems.length === 0) return { status: "pass", detail: "Category mix healthy", evidence: [] };
  return {
    status: "fail",
    detail: problems.join("; "),
    evidence: problems,
    gaps: problems.map((problem, index) => ({
      id: `gap_mix_${index}`,
      ruleId: "category-mix",
      kind: "thin_category",
      severity: "advisory",
      target: "",
      autoFixable: false,
      hint: `Category balance: ${problem}.`,
    })),
  };
}

/**
 * Advisory reward for real journeys. A plan of single-click flows can satisfy
 * every coverage rule while testing no actual user path, and nothing else in
 * the checklist notices.
 */
function checkJourneyDepth({ plan }) {
  const flows = plan.flows ?? [];
  if (flows.length === 0) return { status: "skipped", detail: "No flows", evidence: [] };
  const journeys = flows.filter((flow) => (flow.steps ?? []).length >= 2);
  if (journeys.length > 0) {
    return { status: "pass", detail: `${journeys.length}/${flows.length} flow(s) are multi-step journeys`, evidence: journeys.map((flow) => flow.id) };
  }
  return {
    status: "fail",
    detail: "Every flow is a single step; no user journey is exercised end to end",
    evidence: flows.map((flow) => flow.id),
    gaps: [{
      id: "gap_journey_0",
      ruleId: "journey-depth",
      kind: "shallow_plan",
      severity: "advisory",
      target: "",
      autoFixable: false,
      hint: "Where the crawl shows a sequence (cart -> checkout -> confirmation), plan it as one flow with ordered steps rather than disconnected single-step flows.",
    }],
  };
}

function checkPromptHonored({ plan, prompt }) {
  if (!prompt) return { status: "skipped", detail: "No prompt scope", evidence: [] };
  const flows = plan.flows ?? [];
  if (flows.length === 0) {
    return {
      status: "fail",
      detail: "No flows for prompt",
      evidence: [],
      gaps: [{ id: "gap_prompt_0", ruleId: "prompt-honored", kind: "prompt_ignored", severity: "blocking", target: "", autoFixable: false, hint: `The developer asked to focus on: ${prompt}` }],
    };
  }
  const hits = flows.filter((flow) => promptHits(`${flow.title} ${flow.rationale ?? ""} ${[...pagesTouched(flow)].join(" ")}`, prompt));
  if (hits.length / flows.length >= 0.3) return { status: "pass", detail: `${hits.length}/${flows.length} flows honor prompt`, evidence: [] };
  return {
    status: "fail",
    detail: `Only ${hits.length}/${flows.length} flows touch prompt scope`,
    evidence: promptKeywords(prompt),
    // A blocking rule must name something the planner can act on, or the
    // replan loop can never fire and the run escalates on attempt one.
    gaps: [{
      id: "gap_prompt_0",
      ruleId: "prompt-honored",
      kind: "prompt_ignored",
      severity: "blocking",
      target: "",
      autoFixable: false,
      hint: `The developer asked to focus on "${prompt}". Weight the plan toward those areas while keeping baseline coverage elsewhere.`,
    }],
  };
}

function checkEdgeBoundary({ plan, siteMap }) {
  const needsEdge = (siteMap?.pages ?? []).filter((page) => page.signals?.numeric || page.signals?.list);
  if (needsEdge.length === 0) return { status: "skipped", detail: "No boundary surface", evidence: [] };
  const missing = needsEdge.filter((page) => !(plan.flows ?? []).some((flow) => flow.category === "edge" && (flow.pages ?? []).includes(page.path)));
  if (missing.length === 0) return { status: "pass", detail: "Boundary edges covered", evidence: [] };
  const severity = (plan.flows ?? []).some((flow) => flow.category === "edge") ? "advisory" : "blocking";
  return {
    status: "fail",
    detail: `${missing.length} boundary page(s) lack edge flows`,
    evidence: missing.map((page) => page.path),
    gaps: missing.map((page, index) => ({
      id: `gap_edge_${index}`,
      ruleId: "edge-boundary",
      kind: "missing_flow",
      severity,
      target: page.path,
      autoFixable: true,
      suggestion: { id: `flow_${page.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}-edge`, title: `Cover edge state on ${page.path}`, category: "edge", priority: "medium", pages: [page.path], steps: [{ intent: `Exercise the boundary on ${page.path}`, expect: ["A validation or empty state is shown"] }] },
    })),
  };
}

function checkOrphanPage({ plan, siteMap, prompt }) {
  if ((siteMap?.pages ?? []).length === 0) return { status: "skipped", detail: "No pages discovered", evidence: [] };
  const covered = new Set((plan.flows ?? []).flatMap((flow) => [...pagesTouched(flow)]));
  const orphans = (siteMap?.pages ?? []).filter((page) => !covered.has(page.path));
  if (orphans.length === 0) return { status: "pass", detail: "All pages covered", evidence: [] };
  // Pages the developer scoped out are reported, never counted against the plan.
  const inScope = orphans.filter((page) => scopeFor(prompt, page) === "blocking");
  if (prompt && inScope.length === 0) {
    return { status: "pass", detail: `${orphans.length} page(s) uncovered, all outside the developer's stated scope`, evidence: orphans.map((page) => page.path) };
  }
  return {
    status: "fail",
    detail: `${inScope.length || orphans.length} page(s) in no flow`,
    evidence: (inScope.length > 0 ? inScope : orphans).map((page) => page.path),
    gaps: (inScope.length > 0 ? inScope : orphans).map((page, index) => ({
      id: `gap_orphan_${index}`,
      ruleId: "orphan-page",
      kind: "uncovered_page",
      severity: "advisory",
      target: page.path,
      autoFixable: false,
      hint: `${page.path} was discovered by the crawl but no flow touches it.`,
    })),
  };
}

function checkDestructiveGuard({ plan }) {
  const risky = (plan.flows ?? []).filter((flow) => /delete|pay|place order/i.test(flow.title));
  if (risky.length === 0) return { status: "skipped", detail: "No destructive surface", evidence: [] };
  const unguarded = risky.filter((flow) => !(flow.steps ?? []).some((step) => /verif|confirm|only one/i.test((step.expect ?? []).map(expectationText).join(" "))));
  if (unguarded.length === 0) return { status: "pass", detail: "Destructive flows verified", evidence: [] };
  return { status: "fail", detail: `${unguarded.length} destructive flow(s) lack verification`, evidence: unguarded.map((f) => f.id), gaps: [] };
}

function checkPrdCoverage({ plan, prd }) {
  const requirements = prd?.requirements ?? [];
  if (requirements.length === 0) return { status: "skipped", detail: "No PRD scope", evidence: [] };
  const uncovered = requirements.filter((req) => !(plan.flows ?? []).some((flow) => (flow.requirementIds ?? []).includes(req.id)));
  if (uncovered.length === 0) return { status: "pass", detail: "PRD fully mapped", evidence: [] };
  return { status: "fail", detail: `${uncovered.length}/${requirements.length} requirements uncovered`, evidence: uncovered.map((r) => r.id), gaps: [] };
}

const CHECKS = {
  "happy-path-coverage": checkHappyPath,
  "error-state-per-form": checkErrorPerForm,
  "auth-negative": checkAuthNegative,
  "assertion-presence": checkAssertionPresence,
  "checkable-assertions": checkCheckableAssertions,
  "prompt-honored": checkPromptHonored,
  "category-mix": checkCategoryMix,
  "journey-depth": checkJourneyDepth,
  "edge-boundary": checkEdgeBoundary,
  "orphan-page": checkOrphanPage,
  "destructive-guard": checkDestructiveGuard,
  "prd-coverage": checkPrdCoverage,
};

export function evaluatePlan({ plan, siteMap = { pages: [] }, prd = { requirements: [] }, prompt = "" } = {}) {
  const checklist = [];
  const gaps = [];
  for (const rule of COVERAGE_RULES) {
    const result = CHECKS[rule.id]({ plan, siteMap, prd, prompt });
    // A rule may downgrade itself — a coverage miss confined to pages the
    // developer scoped out reports without blocking the run.
    const severity = result.severity ?? result.gaps?.[0]?.severity ?? rule.severity;
    checklist.push({ ruleId: rule.id, severity, ...result });
    gaps.push(...(result.gaps ?? []));
  }
  const score = scorePlan(checklist);
  const untestedRisks = (siteMap.pages ?? [])
    .filter((page) => !planCoversPage(plan, page.path))
    .map((page) => ({
      area: page.path,
      reason: prompt && scopeFor(prompt, page) === "advisory"
        ? "no flow covers this page (outside the developer's stated scope)"
        : "no flow covers this page",
      risk: prompt && scopeFor(prompt, page) === "advisory" ? "low" : "medium",
      impact: "unverified surface",
    }));
  return {
    version: 1,
    planId: plan?.id ?? "plan_unknown",
    attempt: plan?.attempt ?? 1,
    score,
    checklist: checklist.map(({ gaps: _gaps, ...entry }) => entry),
    gaps,
    untestedRisks,
  };
}

export function scorePlan(checklist) {
  if (!checklist || checklist.length === 0) return 0;
  const applicable = checklist.filter((entry) => entry.status !== "skipped");
  if (applicable.length === 0) return 1;
  let total = 0;
  let earned = 0;
  for (const entry of applicable) {
    const weight = entry.severity === "blocking" ? 3 : 1;
    total += weight;
    if (entry.status === "pass") earned += weight;
  }
  return total === 0 ? 0 : Math.round((earned / total) * 100) / 100;
}

export function decideVerdict({ checklist, gaps = [], attempt = 1, maxReplans = 2, prevScore, score } = {}) {
  const entries = checklist ?? [];
  const blocking = entries.filter((entry) => entry.severity === "blocking" && entry.status === "fail");
  const resolvedScore = score ?? scorePlan(entries);
  const allGaps = gaps.length > 0 ? gaps : entries.flatMap((entry) => entry.gaps ?? []);
  if (blocking.length === 0 && resolvedScore >= 0.75) return "pass";
  const fixableGaps = allGaps.filter((gap) => gap.autoFixable);
  const hasUnfixableBlocking = blocking.some((entry) => {
    const related = (entry.gaps ?? allGaps.filter((gap) => gap.ruleId === entry.ruleId));
    return related.length === 0 || related.some((gap) => !gap.autoFixable);
  });
  if (hasUnfixableBlocking) return "escalate";
  if (blocking.length === 0 && resolvedScore < 0.75) {
    if (attempt < maxReplans && fixableGaps.length > 0) {
      if (prevScore !== undefined && resolvedScore <= prevScore) return "escalate";
      return "replan";
    }
    return "escalate";
  }
  if (attempt < maxReplans && fixableGaps.length > 0) {
    if (prevScore !== undefined && resolvedScore <= prevScore) return "escalate";
    return "replan";
  }
  return "escalate";
}

export function renderGapsMarkdown(gaps) {
  const lines = [`# Coverage gaps (${gaps?.gaps?.length ?? 0}) — score ${gaps?.score ?? 0}`, ""];
  for (const gap of gaps?.gaps ?? []) {
    lines.push(`- [${gap.severity}] ${gap.ruleId} → ${gap.target || "plan"}: ${gap.suggestion?.title ?? gap.kind}`);
  }
  if ((gaps?.untestedRisks ?? []).length > 0) {
    lines.push("", "## Untested risks");
    for (const risk of gaps.untestedRisks) lines.push(`- ${risk.area}: ${risk.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
