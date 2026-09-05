// Planner sub-agent.
//
// The orchestrator does not talk to a model. It states what it needs, hands
// that brief to whatever planner capability the host provides — the agent that
// installed the skill — and validates whatever comes back against
// schemas/plan-draft.schema.json before trusting a word of it.
//
// This mirrors how native execution already works: the skill ships the rails
// and the contract, the host agent brings the judgement. No provider client,
// no API key, no outbound network call from the runtime.
//
// If no planner capability is available, or the draft fails validation twice,
// the deterministic planner in planner.js is used and `plan.source` records
// exactly why. The pipeline never breaks for want of a planner.

import { buildTestPlan } from "./planner.js";
import { validateDocument } from "./schema-validator.js";
import { QaError } from "./errors.js";

/**
 * Briefing given to the Planner sub-agent. SKILL.md points at this text so the
 * instructions the sub-agent follows and the ones the runtime documents cannot
 * drift apart.
 */
export const PLANNER_INSTRUCTIONS = `You are the Planner in an autonomous test orchestration pipeline. You are given a crawl of a live web application and you produce a test plan that another sub-agent will turn into executable browser tests.

You are a senior QA engineer. Plan what a careful human tester would actually check.

WHAT MAKES A GOOD PLAN
- Cover happy paths, error states, and edge cases. A plan that is only happy paths is a failed plan.
- Cover all four QA dimensions when the application exposes them: core functionality; constraints and state invariants; interaction feedback and state transitions; and content accuracy, completeness, and cross-view consistency.
- Decompose every explicit product requirement into at least one binary check. Include latent rules implied by the requirement, such as invalid dates, duplicate actions, permissions, persistence, filtering accuracy, and consistency between list and detail views.
- Prefer real multi-step journeys over single clicks. If the crawl shows cart -> checkout -> confirmation, plan that as ONE flow with ordered steps, not three disconnected flows.
- Every form deserves at least one success case and one rejection case (missing required field, invalid format, or invalid credentials).
- Look for destructive or money-moving actions and plan a guard for them (double submission, confirmation required).
- Verify observable feedback after actions and verify that saved or selected state survives the transitions the requirement promises. Do not treat a click that merely completes without an error as proof that the product outcome is correct.
- If a page is reachable only when signed in, put "authenticated" in preconditions and make the FIRST step of the flow sign in, unless a precondition handles it.

THE ASSERTION RULE — THIS IS THE MOST IMPORTANT RULE
Each expectation has two parts:
  - "prose": what a human would write, e.g. "Order confirmation is visible".
  - "assert": a predicate a browser can evaluate.

The assert value MUST be a string you have reason to believe literally appears in the rendered page. Derive it from the crawled page titles, headings, link text, and button labels you were given.

NEVER copy the prose into the assert value. "Order confirmation is visible" is a description, not page text — asserting it would always fail. If the crawl shows the confirmation page has the heading "Thank you for your order", then the assert value is "Thank you for your order".

If you genuinely cannot determine the observable text for an expectation, use kind "url_contains" with the path you expect to land on, or omit the assert entirely and add a line to openQuestions. Do not invent page text you did not observe. An expectation with no predicate is honest; a predicate you made up is not.

Predicate kinds:
  - text          -> value appears somewhere visible on the page
  - absent_text   -> value must NOT appear (use for "no error is shown")
  - url_contains  -> the URL contains value after the step
  - visible       -> the CSS selector resolves to a visible element
  - absent        -> the CSS selector resolves to nothing
  - count         -> the CSS selector resolves to exactly count elements

INPUTS
When a step submits a form, list every field it fills using the exact input name from the site map. Use realistic values (a valid-looking test card number, a plausible email). For a deliberately-invalid case, use the invalid value that triggers the rejection you are asserting. Mark passwords and tokens sensitive: true.

SCOPE
If the developer gave a natural-language focus, weight the plan toward it — but still return baseline coverage for the rest of the application. If a PRD was provided, set requirementIds on the flows that cover each requirement, and leave it empty when nothing covers it. Do not claim coverage you did not plan.

Return only a JSON document matching schemas/plan-draft.schema.json.`;

const MAX_BRIEF_CHARS = 60_000;

/** Compact the crawl into what a planner needs: structure and observable strings. */
export function renderSiteMapBrief(siteMap, { maxChars = MAX_BRIEF_CHARS } = {}) {
  const lines = [];
  for (const page of siteMap?.pages ?? []) {
    lines.push(`### ${page.path}  (HTTP ${page.status}, depth ${page.depth})`);
    if (page.title) lines.push(`title: ${page.title}`);
    if ((page.headings ?? []).length > 0) {
      lines.push(`headings: ${page.headings.map((heading) => `h${heading.level} "${heading.text}"`).join(", ")}`);
    }
    if ((page.links ?? []).length > 0) {
      const links = page.links.slice(0, 25).map((link) => `"${link.text || "(no text)"}" -> ${link.href}`);
      lines.push(`links: ${links.join(", ")}`);
    }
    for (const [index, form] of (page.forms ?? []).entries()) {
      const inputs = (form.inputs ?? [])
        .map((input) => `${input.name || "(unnamed)"}:${input.type}${input.required ? " required" : ""}${input.placeholder ? ` placeholder="${input.placeholder}"` : ""}`)
        .join(", ");
      lines.push(`form[${index}]: method=${form.method} action="${form.action}" buttons=[${(form.buttons ?? []).join(", ")}] inputs=[${inputs}]`);
    }
    const signals = Object.entries(page.signals ?? {}).filter(([, on]) => on).map(([name]) => name);
    if (signals.length > 0) lines.push(`signals: ${signals.join(", ")}`);
    lines.push("");
  }
  const rendered = lines.join("\n");
  return rendered.length > maxChars ? `${rendered.slice(0, maxChars)}\n… (site map truncated)` : rendered;
}

/** The full briefing handed to the planner capability. */
export function buildPlannerBrief({ siteMap, prompt = "", prd = { requirements: [] } } = {}) {
  const sections = [
    `TARGET: ${siteMap?.origin ?? "unknown"}`,
    siteMap?.auth?.authenticated
      ? "CRAWL SESSION: authenticated (protected pages below were fetched signed in)"
      : "CRAWL SESSION: anonymous (login either was not attempted or did not succeed — treat protected pages with suspicion)",
    siteMap?.degraded
      ? "WARNING: the crawl looks degraded (very few links/forms found). The app may render client-side, so the structure below may be incomplete. Say so in openQuestions."
      : "",
    "",
    "## Crawled pages",
    renderSiteMapBrief(siteMap),
  ];
  if (prompt) sections.push("## Developer focus (natural language)", prompt, "");
  const requirements = prd?.requirements ?? [];
  if (requirements.length > 0) {
    sections.push("## Product requirements", ...requirements.map((requirement) => `- ${requirement.id}: ${requirement.text}`), "");
  }
  sections.push("Produce the test plan now.");
  return sections.filter((section) => section !== "").join("\n");
}

function slugFlowId(value, index) {
  const slug = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `flow_${slug || `plan-${index + 1}`}`;
}

function stripEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

/** Draft shape -> the internal plan shape the gate, generator and reporter expect. */
export function normalizePlan({ draft, siteMap, prompt = "", prd = { requirements: [] }, source, now = () => new Date() } = {}) {
  const at = now instanceof Date ? now : now();
  const generatedAt = (at instanceof Date ? at : new Date(at)).toISOString();
  const seen = new Set();
  const flows = [];

  for (const [index, flow] of (draft?.flows ?? []).entries()) {
    let id = flow.id?.startsWith("flow_") ? flow.id : slugFlowId(flow.id ?? flow.title, index);
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    flows.push({
      id,
      title: flow.title,
      category: flow.category,
      priority: flow.priority,
      rationale: flow.rationale ?? "",
      pages: flow.pages ?? [],
      preconditions: flow.preconditions ?? [],
      risks: flow.risks ?? [],
      requirementIds: flow.requirementIds ?? [],
      steps: (flow.steps ?? []).map((step) => ({
        intent: step.intent,
        ...(step.page ? { page: step.page } : {}),
        ...(step.action ? { action: step.action } : {}),
        ...(step.channel ? { channel: step.channel } : {}),
        ...((step.inputs ?? []).length > 0 ? { inputs: step.inputs } : {}),
        expect: (step.expect ?? []).map((expectation) => ({
          prose: expectation.prose,
          ...(expectation.assert && expectation.assert.kind ? { assert: stripEmpty(expectation.assert) } : {}),
        })),
      })),
    });
  }

  const counts = { happy: 0, edge: 0, error: 0 };
  for (const flow of flows) counts[flow.category] = (counts[flow.category] ?? 0) + 1;

  return {
    version: 1,
    id: `plan_${Date.parse(generatedAt)}`,
    target: siteMap?.origin ?? "",
    generatedAt,
    attempt: 1,
    source,
    guidance: { prompt, prd: { requirements: prd?.requirements ?? [] } },
    siteMapRef: "site-map.json",
    flows,
    coverageClaims: counts,
    openQuestions: draft?.openQuestions ?? [],
    ...(draft?.notes ? { notes: draft.notes } : {}),
  };
}

/** Reject a draft that validation cannot vouch for, with a reason the planner can act on. */
export function reviewDraft(draft) {
  if (!draft || typeof draft !== "object") {
    return { ok: false, reason: "the planner returned no document" };
  }
  try {
    validateDocument("planDraft", draft);
  } catch (error) {
    const issues = (error.issues ?? []).slice(0, 8).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    return { ok: false, reason: issues || (error instanceof Error ? error.message : String(error)) };
  }
  if (!Array.isArray(draft.flows) || draft.flows.length === 0) {
    return { ok: false, reason: "the plan contains no flows" };
  }
  return { ok: true };
}

/**
 * Plan with the host's planner capability, falling back to the deterministic
 * planner. Always returns a plan; `plan.source` records which path was taken
 * and, when it fell back, exactly why.
 *
 * `planner` is `async ({ brief, instructions, schema, siteMap, prompt, prd, feedback }) => draft`.
 * It is the same shape of contract as `nativeExecutor`: a capability the host
 * supplies, not a dependency the runtime resolves.
 */
export async function planWithAgent({
  planner,
  siteMap,
  prompt = "",
  prd = { requirements: [] },
  attempts = 2,
  emit,
  now = () => new Date(),
} = {}) {
  const fallback = (reason) => {
    const plan = buildTestPlan({ siteMap, prompt, prd, now });
    plan.source = { planner: "deterministic", fellBack: true, fallbackReason: reason };
    return plan;
  };

  if (typeof planner !== "function") return fallback("no planner capability was provided");

  const brief = buildPlannerBrief({ siteMap, prompt, prd });
  let feedback;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let draft;
    try {
      await emit?.("plan", "planner_started", { message: `Planner sub-agent, attempt ${attempt}` });
      draft = await planner({
        brief,
        instructions: PLANNER_INSTRUCTIONS,
        schema: "plan-draft.schema.json",
        siteMap,
        prompt,
        prd,
        ...(feedback ? { feedback } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await emit?.("plan", "planner_failed", { level: "warn", message: `Planner capability failed: ${reason}` });
      return fallback(reason);
    }

    const review = reviewDraft(draft);
    if (review.ok) {
      const plan = normalizePlan({
        draft,
        siteMap,
        prompt,
        prd,
        now,
        source: { planner: "agent", fellBack: false, attempts: attempt },
      });
      await emit?.("plan", "planner_completed", {
        message: `${plan.flows.length} flows · ${plan.openQuestions.length} open question(s) · attempt ${attempt}`,
      });
      return plan;
    }

    await emit?.("plan", "planner_rejected", { level: "warn", message: `attempt ${attempt}: ${review.reason}` });
    feedback = `Your previous plan draft was rejected. Fix exactly these problems and return only the corrected JSON document:\n${review.reason}`;
    if (attempt === attempts) return fallback(`plan draft rejected after ${attempts} attempt(s): ${review.reason}`);
  }

  // Unreachable: the loop either returns a plan or falls back on its last turn.
  throw new QaError("PLANNER_UNREACHABLE_STATE", "The planner loop exited without a decision");
}
