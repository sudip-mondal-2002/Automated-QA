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
  const lines = String(text).split(/\r?\n/);
  const requirements = [];
  for (const line of lines) {
    const trimmed = line.trim().replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (trimmed.length < 8) continue;
    const idMatch = trimmed.match(/(REQ-[A-Za-z0-9-]+)/i);
    const id = idMatch ? idMatch[1].toUpperCase() : `REQ-${requirements.length + 1}`;
    requirements.push({ id, text: trimmed, keywords: trimmed.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 8) });
  }
  return { requirements };
}

function slugifyFlow(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "flow";
}

function promptMatches(text, prompt) {
  if (!prompt) return false;
  const keywords = String(prompt).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const hay = String(text).toLowerCase();
  return keywords.some((keyword) => hay.includes(keyword));
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
    return requirements.filter((req) => req.keywords?.some((keyword) => hay.includes(keyword))).map((req) => req.id);
  };

  for (const page of pages) {
    for (const [formIndex, form] of (page.forms ?? []).entries()) {
      const base = `${page.path}-form-${formIndex}`;
      const isLogin = (form.inputs ?? []).some((input) => input.type === "password");
      const happyTitle = isLogin ? `Sign in via ${page.path}` : `Submit form on ${page.path}`;
      const happyFlow = {
        id: `flow_${slugifyFlow(`${base}-happy`)}`,
        title: happyTitle,
        category: isLogin ? "happy" : "happy",
        priority: promptMatches(`${page.path} ${happyTitle}`, prompt) ? "critical" : "high",
        rationale: `Form discovered at ${page.path} with ${(form.inputs ?? []).length} inputs`,
        pages: [page.path],
        preconditions: isLogin ? [] : ["authenticated"],
        steps: [{
          intent: happyTitle,
          page: page.path,
          action: "submit",
          targetRef: `form:${formIndex}`,
          expect: isLogin ? ["Customer dashboard is visible"] : ["The submitted outcome is visible"],
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
            expect: [`A validation error names the ${input.name || "required"} field`, "No record is created"],
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
          steps: [{ intent: "Sign in with invalid credentials", page: page.path, expect: ["An error message is shown"] }],
          risks: [],
          requirementIds: requirementFor("login sign in"),
        });
        flows.push({
          id: `flow_${slugifyFlow("unauthenticated-redirect")}`,
          title: "Redirect unauthenticated deep links to login",
          category: "error",
          priority: "high",
          rationale: "Authenticated surface requires unauthenticated coverage",
          pages: ["/dashboard"],
          preconditions: [],
          steps: [{ intent: "Open a protected page without signing in", page: "/dashboard", expect: ["Sign in is required"] }],
          risks: [],
          requirementIds: [],
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
        steps: [{ intent: `Open ${page.path} with no records`, page: page.path, expect: ["An empty state is visible"] }],
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
        steps: [{ intent: "Submit a negative quantity", page: page.path, expect: ["A validation error is shown"] }],
        risks: [],
        requirementIds: requirementFor(page.path),
      });
    }
    if (page.signals?.payment) {
      flows.push({
        id: `flow_${slugifyFlow(`${page.path}-double-submit`)}`,
        title: `Guard double submission on ${page.path}`,
        category: "edge",
        priority: "medium",
        rationale: "Payment signal discovered",
        pages: [page.path],
        preconditions: ["authenticated"],
        steps: [{ intent: "Submit payment twice quickly", page: page.path, expect: ["Only one order is created"] }],
        risks: ["double submission"],
        requirementIds: requirementFor("payment checkout order"),
      });
    }
  }

  const seen = new Set();
  const deduped = flows.filter((flow) => {
    if (seen.has(flow.id)) return false;
    seen.add(flow.id);
    return true;
  });

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
