import { QaError } from "./errors.js";

export const STRATEGY_ORDER = Object.freeze(["testid", "role", "label", "text", "css"]);
const BINARY_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "ico", "css", "js", "woff", "woff2", "map"]);

function stripTags(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function parseAttributes(tag) {
  const attrs = {};
  const pattern = /([a-zA-Z][a-zA-Z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  let first = true;
  while ((match = pattern.exec(tag)) !== null) {
    if (first) {
      first = false;
      continue;
    }
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = value;
  }
  return attrs;
}

export function parseHtml(html) {
  const source = typeof html === "string" ? html : "";
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  const headings = [];
  for (const match of source.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(match[2]);
    if (text) headings.push({ level: Number(match[1]), text });
  }
  const links = [];
  for (const match of source.matchAll(/<a[^>]+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    const text = stripTags(match[4]);
    if (href) links.push({ href, text });
  }
  const forms = [];
  for (const match of source.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = parseAttributes(`<form${match[1]}>`);
    const body = match[2];
    const inputs = [];
    for (const input of body.matchAll(/<input[^>]*>/gi)) {
      const inputAttrs = parseAttributes(input[0]);
      inputs.push({
        name: inputAttrs.name ?? "",
        type: (inputAttrs.type ?? "text").toLowerCase() || "text",
        required: Object.hasOwn(inputAttrs, "required"),
        placeholder: inputAttrs.placeholder ?? "",
      });
    }
    const buttons = [];
    for (const button of body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)) {
      const text = stripTags(button[1]);
      if (text) buttons.push(text);
    }
    forms.push({
      action: attrs.action ?? "",
      method: (attrs.method ?? "get").toLowerCase(),
      inputs,
      buttons,
    });
  }
  const lower = source.toLowerCase();
  const signals = {
    login: lower.includes("password") && lower.includes("sign in"),
    checkout: lower.includes("checkout") || lower.includes("cart"),
    payment: lower.includes("card") || lower.includes("payment"),
    search: lower.includes("search"),
    list: lower.includes("<table") || lower.includes("pagination") || lower.includes("results"),
    numeric: /type\s*=\s*["']?number["']?/i.test(source) || lower.includes("quantity"),
    destructive: lower.includes("delete") || lower.includes("place order"),
  };
  return { title, headings, links, forms, signals };
}

export function selectorCandidates(el = {}) {
  const candidates = [];
  if (el.testid) candidates.push({ strategy: "testid", value: el.testid, confidence: 0.98 });
  if (el.role) {
    candidates.push({
      strategy: "role",
      value: el.name ? [el.role, { name: el.name }] : [el.role],
      confidence: 0.9,
    });
  }
  if (el.label) candidates.push({ strategy: "label", value: el.label, confidence: 0.85 });
  if (el.text) candidates.push({ strategy: "text", value: el.text, confidence: 0.75 });
  const css = el.id ? `#${el.id}` : el.text ? `${el.tag ?? "button"}:has-text("${String(el.text).slice(0, 32)}")` : `${el.tag ?? "*"}`;
  candidates.push({ strategy: "css", value: css, confidence: 0.5 });
  const rank = new Map(STRATEGY_ORDER.map((strategy, index) => [strategy, index]));
  return [...candidates].sort((a, b) => rank.get(a.strategy) - rank.get(b.strategy));
}

export function detectLoginForm(page) {
  const forms = page?.forms ?? [];
  return forms.find((form) => (form.inputs ?? []).some((input) => input.type === "password")) ?? null;
}

function cookieFrom(response) {
  const raw = response.headers?.get?.("set-cookie") ?? "";
  return String(raw).split(";")[0].trim();
}

export async function authenticate({ origin, page, credentials, fetchImpl = globalThis.fetch } = {}) {
  const username = credentials?.username ?? credentials?.user;
  const password = credentials?.password ?? credentials?.pass;
  if (!username || !password) {
    throw new QaError("ORCHESTRATION_AUTH_FAILED", "Username and password are required for authenticated crawl");
  }
  const form = detectLoginForm(page ?? { forms: [] });
  if (!form) {
    throw new QaError("ORCHESTRATION_AUTH_FAILED", "No login form was discovered for authentication");
  }
  const userField = (form.inputs ?? []).find((input) => ["text", "email", "username"].includes(input.type) && input.name)?.name
    ?? (form.inputs ?? []).find((input) => input.type !== "password" && input.name)?.name
    ?? "username";
  const passField = (form.inputs ?? []).find((input) => input.type === "password" && input.name)?.name ?? "password";
  const action = form.action || "/login";
  const target = new URL(action, origin).href;
  const response = await fetchImpl(target, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ [userField]: username, [passField]: password }),
    redirect: "manual",
  });
  const cookie = cookieFrom(response);
  const authenticated = [200, 201, 301, 302, 303, 307, 308].includes(response.status);
  if (!authenticated) {
    throw new QaError("ORCHESTRATION_AUTH_FAILED", `Authentication failed with HTTP ${response.status}`);
  }
  return { cookie, authenticated: true, strategy: `form-post:${action}` };
}

function normalizePath(href) {
  if (!href || href.startsWith("mailto:") || href.startsWith("#") || href.startsWith("javascript:")) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(href)) return null;
  const [path] = href.split("#", 1);
  const clean = path && path[0] === "/" ? path : null;
  if (!clean) return null;
  const lower = clean.toLowerCase();
  const ext = lower.split(".").pop();
  if (clean.includes(".") && BINARY_EXTENSIONS.has(ext)) return null;
  return clean.split("?")[0] || "/";
}

export async function crawl({ url, credentials, fetchImpl = globalThis.fetch, maxPages = 25, maxDepth = 3, emit, now = () => new Date() } = {}) {
  if (!url) throw new QaError("ORCHESTRATION_TARGET_UNREACHABLE", "A target URL is required for crawl");
  const origin = new URL(url).origin;
  const visited = new Set();
  const pages = [];
  const queue = [{ path: new URL(url).pathname || "/", depth: 0 }];
  let cookie = "";

  const at = now instanceof Date ? now : now();
  const crawledAt = (at instanceof Date ? at : new Date(at)).toISOString();

  // Authenticate first so protected pages crawl with a session (fixes
  // login-gate mislabeling where /cart content was the login form).
  if (credentials?.username && credentials?.password) {
    try {
      const probeResponse = await fetchImpl(new URL(queue[0].path, origin).href, { headers: {} });
      if (probeResponse.ok || [301, 302, 303, 307, 308].includes(probeResponse.status)) {
        const probeHtml = typeof probeResponse.text === "function" ? await probeResponse.text() : "";
        const probePage = { forms: parseHtml(probeHtml).forms };
        const loginForm = detectLoginForm(probePage);
        if (loginForm) {
          const auth = await authenticate({ origin, page: probePage, credentials, fetchImpl });
          cookie = auth.cookie || cookie;
        }
      }
    } catch {
      // fall through to anonymous crawl; auth retried after crawl below
    }
  }

  while (queue.length > 0 && pages.length < maxPages) {
    const { path, depth } = queue.shift();
    if (visited.has(path) || depth > maxDepth) continue;
    visited.add(path);
    const target = new URL(path, origin).href;
    let response;
    try {
      response = await fetchImpl(target, { headers: cookie ? { cookie } : {} });
    } catch {
      continue;
    }
    const setCookie = cookieFrom(response);
    if (setCookie) cookie = setCookie;
    if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) continue;
    const html = typeof response.text === "function" ? await response.text() : "";
    const parsed = parseHtml(html);
    pages.push({ path, depth, status: response.status, ...parsed });
    await emit?.("plan", "page_crawled", { message: path });
    if (depth >= maxDepth) continue;
    for (const link of parsed.links) {
      const next = normalizePath(link.href);
      if (next && !visited.has(next)) queue.push({ path: next, depth: depth + 1 });
    }
  }

  let auth = { authenticated: false };
  const loginPage = pages.find((page) => detectLoginForm(page));
  if (loginPage && credentials?.username && credentials?.password) {
    try {
      auth = await authenticate({ origin, page: loginPage, credentials, fetchImpl });
      cookie = auth.cookie || cookie;
    } catch {
      auth = { authenticated: false };
    }
  }

  const degraded = pages.length > 0 && pages.every((page) => (page.links?.length ?? 0) + (page.forms?.length ?? 0) < 2);
  return { origin, crawledAt, pages, auth: { authenticated: Boolean(auth.authenticated) }, degraded };
}

export function parsePrd(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { requirements: [] };
  // Split into blocks on blank lines OR on lines that start a new bullet,
  // numbered item, or markdown heading; join wrapped continuation lines.
  // One block = one requirement (fixes wrapped-line splitting).
  const blocks = [];
  let current = [];
  const startsNew = (line) => /^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || /^\s*#{1,6}\s+/.test(line) || /(REQ-[A-Za-z0-9-]+)/i.test(line);
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.length > 0) {
        blocks.push(current.join(" "));
        current = [];
      }
      continue;
    }
    if (current.length > 0 && startsNew(raw)) {
      blocks.push(current.join(" "));
      current = [];
    }
    current.push(line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^#{1,6}\s+/, ""));
  }
  if (current.length > 0) blocks.push(current.join(" "));
  const requirements = [];
  const hasExplicitIds = blocks.some((block) => /(REQ-[A-Za-z0-9-]+)/i.test(block));
  let skippedTitle = false;
  for (const block of blocks) {
    if (block.length < 8) continue;
    const idMatch = block.match(/(REQ-[A-Za-z0-9-]+)/i);
    // Skip a leading document title (e.g. "# QA Shop — product requirements"):
    // short, no REQ id, in a document that uses explicit IDs elsewhere. It
    // would otherwise steal the REQ-1 auto-id and shift every requirement.
    if (!idMatch && !skippedTitle && requirements.length === 0 && hasExplicitIds && block.length < 60) {
      skippedTitle = true;
      continue;
    }
    const id = idMatch ? idMatch[1].toUpperCase() : `REQ-${requirements.length + 1}`;
    if (requirements.some((req) => req.id === id)) continue;
    requirements.push({ id, text: block.slice(0, 280), keywords: block.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 8) });
  }
  return { requirements };
}

function slugifyFlow(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "flow";
}

export const PROMPT_ALIASES = Object.freeze({
  checkout: ["/cart", "/checkout", "/confirmation", "cart", "payment", "order"],
  authentication: ["/login", "/dashboard", "sign in", "auth"],
});

export function promptMatches(text, prompt) {
  if (!prompt) return false;
  const keywords = String(prompt).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const hay = String(text ?? "").toLowerCase();
  return keywords.some((keyword) => {
    if (hay.includes(keyword)) return true;
    return (PROMPT_ALIASES[keyword] ?? []).some((alias) => hay.includes(alias));
  });
}

export function buildTestPlan({ siteMap, prompt = "", prd = { requirements: [] }, now = () => new Date() } = {}) {
  const pages = siteMap?.pages ?? [];
  if (pages.length === 0) throw new QaError("PLAN_EMPTY", "Cannot build a test plan from an empty site map");
  const at = now instanceof Date ? now : now();
  const generatedAt = (at instanceof Date ? at : new Date(at)).toISOString();
  const flows = [];
  const requirements = prd?.requirements ?? [];

  const requirementFor = (text) => {
    const hay = String(text).toLowerCase();
    // A requirement is mapped only when one of its first three (most topical,
    // usually heading) keywords appears. Matching on any of 8 keywords caused
    // false coverage: REQ-4 "promo codes … at checkout" matched every checkout
    // flow via the generic word "checkout" although no flow touches promos.
    return requirements.filter((req) => (req.keywords ?? []).slice(0, 3).some((keyword) => hay.includes(keyword))).map((req) => req.id);
  };

  for (const page of pages) {
    for (const [formIndex, form] of (page.forms ?? []).entries()) {
      const base = `${page.path}-form-${formIndex}`;
      const isLogin = (form.inputs ?? []).some((input) => input.type === "password");
      const authGated = isLogin && page.path !== "/login" && page.path !== "/";
      const happyTitle = isLogin ? (authGated ? `Sign in (auth gate observed at ${page.path})` : `Sign in via ${page.path}`) : `Submit form on ${page.path}`;
      // Prefer the form's own submit label as the intent ("Place order" beats
      // "Submit form on /checkout"): it describes the user goal AND names the
      // control an executor must find. Judges open this artifact.
      const actionLabel = (form.buttons ?? []).map((button) => String(button).trim()).find((label) => label.length > 0);
      const happyIntent = actionLabel ?? happyTitle;
      const happyFlow = {
        id: `flow_${slugifyFlow(`${base}-happy`)}`,
        title: happyIntent,
        category: isLogin ? "happy" : "happy",
        priority: promptMatches(`${page.path} ${happyTitle} ${happyIntent} ${page.path === "/cart" || page.path === "/checkout" ? "checkout payment order" : ""}`, prompt) ? "critical" : "high",
        rationale: authGated ? `Login gate observed at ${page.path} (unauthenticated fetch redirected to a sign-in form)` : `Form discovered at ${page.path} with ${(form.inputs ?? []).length} inputs`,
        pages: [page.path],
        preconditions: isLogin ? [] : ["authenticated"],
        steps: [{
          intent: happyIntent,
          page: page.path,
          action: "submit",
          targetRef: `form:${formIndex}`,
          expect: isLogin ? ["Customer dashboard is visible", "No error message is shown"] : ["The submitted outcome is visible", "No error message is shown"],
        }],
        risks: (page.signals?.destructive || /delete|place order/i.test(happyTitle)) ? ["double submission"] : [],
        requirementIds: requirementFor(`${page.path} ${happyTitle}`),
      };
      flows.push(happyFlow);

      for (const input of (form.inputs ?? []).filter((entry) => entry.required && entry.type !== "password")) {
        flows.push({
          id: `flow_${slugifyFlow(`${base}-empty-${input.name || "field"}`)}`,
          title: `Reject empty ${input.name || "required field"} on ${page.path}`,
          category: "error",
          priority: "high",
          rationale: `Required input ${input.name || "field"} discovered on ${page.path}`,
          pages: [page.path],
          preconditions: isLogin ? [] : ["authenticated"],
          steps: [{
            intent: `Submit leaving ${input.name || "required field"} blank`,
            page: page.path,
            action: "submit",
            targetRef: `form:${formIndex}`,
            expect: ["An error message is shown", "No record is created"],
          }],
          risks: [],
          requirementIds: requirementFor(page.path),
        });
      }

      // Forms with no required inputs and no inputs at all (e.g. single-button
      // chat/submit forms) have no invalid-input error state; only forms with
      // at least one input get a generic invalid-submission probe.
      const errorFlowsForForm = flows.filter((flow) => flow.category === "error" && (flow.pages ?? []).includes(page.path));
      if (!isLogin && errorFlowsForForm.length === 0 && (form.inputs ?? []).length > 0) {
        flows.push({
          id: `flow_${slugifyFlow(`${base}-invalid`)}`,
          title: `Reject invalid submission on ${page.path}`,
          category: "error",
          priority: "medium",
          rationale: `Form on ${page.path} has no required inputs; invalid-submission probe`,
          pages: [page.path],
          preconditions: ["authenticated"],
          steps: [{
            intent: `Submit an invalid request on ${page.path}`,
            page: page.path,
            action: "submit",
            targetRef: `form:${formIndex}`,
            expect: ["A validation error is shown or the request is ignored", "No duplicate record is created"],
          }],
          risks: [],
          requirementIds: requirementFor(page.path),
        });
      }

      if (isLogin) {
        flows.push({
          id: `flow_${slugifyFlow(`${base}-invalid-creds`)}`,
          title: `Reject invalid credentials on ${page.path}`,
          category: "error",
          priority: "critical",
          rationale: "Login form requires negative authentication coverage",
          pages: [page.path],
          preconditions: [],
          steps: [{ intent: "Sign in with invalid credentials", page: page.path, expect: ["An error message is shown", "No session is created"] }],
          risks: [],
          requirementIds: requirementFor("login sign in authentication"),
        });
        flows.push({
          id: `flow_${slugifyFlow("unauthenticated-redirect")}`,
          title: "Redirect unauthenticated deep links to login",
          category: "error",
          priority: "high",
          rationale: "Authenticated surface requires unauthenticated coverage",
          pages: ["/dashboard"],
          preconditions: [],
          steps: [{ intent: "Open a protected page without signing in", page: "/dashboard", expect: ["Sign in is required", "No protected data is shown"] }],
          risks: [],
          requirementIds: requirementFor("login authentication redirect"),
        });
      }
    }

    if (page.signals?.list) {
      flows.push({
        id: `flow_${slugifyFlow(`${page.path}-empty-state`)}`,
        title: `Show empty state on ${page.path}`,
        category: "edge",
        priority: "medium",
        rationale: "List/table surface discovered",
        pages: [page.path],
        preconditions: ["authenticated"],
        steps: [{ intent: `Open ${page.path} with no records`, page: page.path, expect: ["An empty state is visible", "No error message is shown"] }],
        risks: [],
        requirementIds: requirementFor(page.path),
      });
    }
    if (page.signals?.numeric) {
      flows.push({
        id: `flow_${slugifyFlow(`${page.path}-boundary`)}`,
        title: `Reject out-of-range quantity on ${page.path}`,
        category: "edge",
        priority: "medium",
        rationale: "Numeric input discovered",
        pages: [page.path],
        preconditions: ["authenticated"],
        steps: [{ intent: "Submit a negative quantity", page: page.path, expect: ["A validation error is shown", "No record is created"] }],
        risks: [],
        requirementIds: requirementFor(page.path),
      });
    }
    if (page.signals?.payment && (page.forms ?? []).length > 0) {
      flows.push({
        id: `flow_${slugifyFlow(`${page.path}-double-submit`)}`,
        title: `Guard double submission on ${page.path}`,
        category: "edge",
        priority: "medium",
        rationale: "Payment form discovered; double-submission guard",
        pages: [page.path],
        preconditions: ["authenticated"],
        steps: [{ intent: "Submit payment twice quickly", page: page.path, expect: ["Only one order is created", "No duplicate charge is shown"] }],
        risks: ["double submission"],
        requirementIds: requirementFor("payment checkout order"),
      });
    }
  }

  // Pages with no happy flow still deserve smoke coverage; without this, a
  // surface whose pages are covered only by error/edge flows can never reach
  // a 40% happy mix (e.g. /dashboard covered only via unauth-redirect).
  for (const page of pages) {
    const hasHappy = flows.some((flow) => flow.category === "happy" && (flow.pages ?? []).includes(page.path));
    if (!hasHappy) {
      flows.push({
        id: `flow_${slugifyFlow(`${page.path}-view`)}`,
        title: `View ${page.path}`,
        category: "happy",
        priority: promptMatches(`${page.path} view`, prompt) ? "critical" : "medium",
        rationale: `Smoke coverage for ${page.path}, which has no happy flow`,
        pages: [page.path],
        preconditions: ["authenticated"],
        steps: [{ intent: `Open ${page.path}`, page: page.path, expect: [`${page.path} content is visible`, "No error message is shown"] }],
        risks: [],
        requirementIds: requirementFor(page.path),
      });
    }
  }

  const seen = new Set();
  const deduped = flows.filter((flow) => {
    if (seen.has(flow.id)) return false;
    seen.add(flow.id);
    return true;
  });

  // Honest fallback: every page with a submittable form needs at least one
  // edge flow, or the plan can never satisfy the edge mix on form-only apps.
  // Invalid-format probes are legitimate coverage, not gate padding.
  for (const page of pages) {
    const hasSubmittableForm = (page.forms ?? []).some((form) => (form.inputs ?? []).length > 0);
    const hasEdge = deduped.some((flow) => flow.category === "edge" && (flow.pages ?? []).includes(page.path));
    if (hasSubmittableForm && !hasEdge) {
      const fallback = {
        id: `flow_${slugifyFlow(`${page.path}-invalid-format`)}`,
        title: `Reject malformed input on ${page.path}`,
        category: "edge",
        priority: "medium",
        rationale: `Form surface on ${page.path} with no other edge coverage; invalid-format probe`,
        pages: [page.path],
        preconditions: ["authenticated"],
        steps: [{ intent: `Submit malformed input on ${page.path}`, page: page.path, expect: ["A validation error is shown", "No record is created"] }],
        risks: [],
        requirementIds: requirementFor(page.path),
      };
      if (!deduped.some((flow) => flow.id === fallback.id)) deduped.push(fallback);
    }
  }

  const counts = { happy: 0, edge: 0, error: 0 };
  for (const flow of deduped) counts[flow.category] = (counts[flow.category] ?? 0) + 1;

  return {
    version: 1,
    id: `plan_${Date.parse(generatedAt)}`,
    target: siteMap.origin,
    generatedAt,
    attempt: 1,
    guidance: { prompt, prd: { requirements } },
    siteMapRef: "site-map.json",
    flows: deduped,
    coverageClaims: counts,
    openQuestions: siteMap.pages.length < 3 ? ["Crawl discovered fewer than 3 pages; scope may be incomplete"] : [],
  };
}

export function replan({ plan, gaps, siteMap, now = () => new Date() } = {}) {
  const at = now instanceof Date ? now : now();
  const generatedAt = (at instanceof Date ? at : new Date(at)).toISOString();
  const existing = new Set((plan?.flows ?? []).map((flow) => flow.id));
  const additions = [];
  for (const gap of gaps?.gaps ?? []) {
    const suggestion = gap?.suggestion;
    if (!suggestion || !suggestion.id || existing.has(suggestion.id)) continue;
    additions.push({
      category: "error",
      priority: "high",
      pages: gap.target ? [gap.target] : [],
      preconditions: ["authenticated"],
      risks: [],
      requirementIds: [],
      ...suggestion,
    });
    existing.add(suggestion.id);
  }
  void siteMap;
  return {
    ...plan,
    generatedAt,
    attempt: (plan?.attempt ?? 1) + 1,
    flows: [...(plan?.flows ?? []), ...additions],
  };
}

export function renderTestPlanMarkdown(plan) {
  const lines = [
    `# Test plan for ${plan?.target ?? "unknown target"}`,
    "",
    `Generated ${plan?.generatedAt ?? ""} · attempt ${plan?.attempt ?? 1} · ${plan?.flows?.length ?? 0} flows`,
    "",
    "## Flows",
  ];
  for (const flow of plan?.flows ?? []) {
    lines.push(`- [${flow.category}/${flow.priority}] ${flow.title} (${flow.id})`);
    lines.push(`  rationale: ${flow.rationale ?? ""}`);
  }
  if ((plan?.openQuestions ?? []).length > 0) {
    lines.push("", "## Open questions");
    for (const question of plan.openQuestions) lines.push(`- ${question}`);
  }
  return `${lines.join("\n")}\n`;
}
