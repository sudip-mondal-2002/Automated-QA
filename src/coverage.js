export const COVERAGE_RULES = Object.freeze([
  { id: "happy-path-coverage", severity: "blocking" },
  { id: "error-state-per-form", severity: "blocking" },
  { id: "auth-negative", severity: "blocking" },
  { id: "assertion-density", severity: "blocking" },
  { id: "category-mix", severity: "blocking" },
  { id: "prompt-honored", severity: "blocking" },
  { id: "edge-boundary", severity: "advisory" },
  { id: "orphan-page", severity: "advisory" },
  { id: "destructive-guard", severity: "advisory" },
  { id: "prd-coverage", severity: "advisory" },
]);

function promptHits(text, prompt) {
  if (!prompt) return false;
  const keywords = String(prompt).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const hay = String(text ?? "").toLowerCase();
  const aliases = {
    checkout: ["/cart", "/checkout", "/confirmation", "cart", "payment", "order"],
    authentication: ["/login", "/dashboard", "sign in", "auth"],
  };
  return keywords.some((keyword) => {
    if (hay.includes(keyword)) return true;
    return (aliases[keyword] ?? []).some((alias) => hay.includes(alias));
  });
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

function checkHappyPath({ plan, siteMap }) {
  if (formPages(siteMap).length === 0) return { status: "skipped", detail: "No form surface discovered", evidence: [] };
  const missing = formPages(siteMap).filter((page) => !(plan.flows ?? []).some((flow) => flow.category === "happy" && (flow.pages ?? []).includes(page.path)));
  if (missing.length === 0) return { status: "pass", detail: "Every form page has a happy flow", evidence: [] };
  return {
    status: "fail",
    detail: `${missing.length} form page(s) have no happy flow`,
    evidence: missing.map((page) => page.path),
    gaps: missing.map((page, index) => ({
      id: `gap_happy_${index}`,
      ruleId: "happy-path-coverage",
      kind: "missing_flow",
      severity: "blocking",
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

function checkErrorPerForm({ plan, siteMap }) {
  const flows = plan.flows ?? [];
  if (submittableFormPages(siteMap).length === 0) return { status: "skipped", detail: "No submittable form surface discovered", evidence: [] };
  const missing = submittableFormPages(siteMap).filter((page) => !flows.some((flow) => flow.category === "error" && (flow.pages ?? []).includes(page.path)));
  if (missing.length === 0) return { status: "pass", detail: "Every form has an error flow", evidence: [] };
  return {
    status: "fail",
    detail: `${missing.length} of ${submittableFormPages(siteMap).length} forms have no error-state flow`,
    evidence: missing.map((page) => page.path),
    gaps: missing.map((page, index) => ({
      id: `gap_error_${index}`,
      ruleId: "error-state-per-form",
      kind: "missing_flow",
      severity: "blocking",
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

function checkAssertionDensity({ plan }) {
  const flows = plan.flows ?? [];
  const thin = flows.filter((flow) => (flow.steps ?? []).some((step) => (step.expect ?? []).length === 0) || (flow.steps ?? []).reduce((n, step) => n + (step.expect ?? []).length, 0) < 2);
  if (thin.length === 0 && flows.length > 0) return { status: "pass", detail: "Assertion density sufficient", evidence: [] };
  if (flows.length === 0) {
    return { status: "fail", detail: "No flows to assert", evidence: [], gaps: [{ id: "gap_assert_0", ruleId: "assertion-density", kind: "missing_assertion", severity: "blocking", target: "", autoFixable: false }] };
  }
  return {
    status: "fail",
    detail: `${thin.length} flow(s) have thin assertions`,
    evidence: thin.map((flow) => flow.id),
    gaps: thin.map((flow) => ({ id: `gap_assert_${flow.id}`, ruleId: "assertion-density", kind: "missing_assertion", severity: "blocking", target: (flow.pages ?? [])[0] ?? "", autoFixable: false })),
  };
}

function checkCategoryMix({ plan }) {
  const flows = plan.flows ?? [];
  if (flows.length === 0) return { status: "fail", detail: "No flows", evidence: [], gaps: [] };
  const happy = flows.filter((f) => f.category === "happy").length / flows.length;
  const error = flows.filter((f) => f.category === "error").length / flows.length;
  const edge = flows.filter((f) => f.category === "edge").length / flows.length;
  const problems = [];
  if (happy < 0.4) problems.push(`happy ${Math.round(happy * 100)}% < 40%`);
  if (error < 0.2) problems.push(`error ${Math.round(error * 100)}% < 20%`);
  if (edge < 0.15) problems.push(`edge ${Math.round(edge * 100)}% < 15%`);
  if (problems.length === 0) return { status: "pass", detail: "Category mix healthy", evidence: [] };
  return { status: "fail", detail: problems.join("; "), evidence: problems, gaps: [] };
}

function checkPromptHonored({ plan, prompt }) {
  if (!prompt) return { status: "skipped", detail: "No prompt scope", evidence: [] };
  const flows = plan.flows ?? [];
  if (flows.length === 0) return { status: "fail", detail: "No flows for prompt", evidence: [], gaps: [] };
  const hits = flows.filter((flow) => promptHits(`${flow.title} ${(flow.pages ?? []).join(" ")}`, prompt)).length;
  if (hits / flows.length >= 0.3) return { status: "pass", detail: `${hits}/${flows.length} flows honor prompt`, evidence: [] };
  return { status: "fail", detail: `Only ${hits}/${flows.length} flows touch prompt scope`, evidence: [], gaps: [] };
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

function checkOrphanPage({ plan, siteMap }) {
  if ((siteMap?.pages ?? []).length === 0) return { status: "skipped", detail: "No pages discovered", evidence: [] };
  const covered = new Set((plan.flows ?? []).flatMap((flow) => flow.pages ?? []));
  const orphans = (siteMap?.pages ?? []).map((page) => page.path).filter((path) => !covered.has(path));
  if (orphans.length === 0) return { status: "pass", detail: "All pages covered", evidence: [] };
  return { status: "fail", detail: `${orphans.length} page(s) in no flow`, evidence: orphans, gaps: [] };
}

function checkDestructiveGuard({ plan }) {
  const risky = (plan.flows ?? []).filter((flow) => /delete|pay|place order/i.test(flow.title));
  if (risky.length === 0) return { status: "skipped", detail: "No destructive surface", evidence: [] };
  const unguarded = risky.filter((flow) => !(flow.steps ?? []).some((step) => /verif|confirm|only one/i.test((step.expect ?? []).join(" "))));
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
  "assertion-density": checkAssertionDensity,
  "category-mix": checkCategoryMix,
  "prompt-honored": checkPromptHonored,
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
    const severity = result.gaps?.[0]?.severity ?? rule.severity;
    checklist.push({ ruleId: rule.id, severity, ...result });
    gaps.push(...(result.gaps ?? []));
  }
  const score = scorePlan(checklist);
  const untestedRisks = (siteMap.pages ?? [])
    .filter((page) => !(plan.flows ?? []).some((flow) => (flow.pages ?? []).includes(page.path)))
    .map((page) => ({ area: page.path, reason: "no flow covers this page", risk: "medium", impact: "unverified surface" }));
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
