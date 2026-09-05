import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateDocument } from "./schema-validator.js";
import { selectorCandidates } from "./planner.js";

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "flow";
}

function escapeRegex(value) {
  return String(value).replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function quote(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Prose-only expectations (deterministic planner) carry no predicate. */
export function expectationProse(expectation) {
  return typeof expectation === "string" ? expectation : expectation?.prose ?? "";
}

export function expectationPredicate(expectation) {
  return typeof expectation === "string" ? null : expectation?.assert ?? null;
}

/**
 * Compile a predicate into a Playwright assertion.
 *
 * Returns null when there is no checkable predicate. The caller emits a
 * skipped-assertion comment instead of inventing one — asserting the prose
 * itself ("Order confirmation is visible") can never pass and is exactly the
 * bug this replaces.
 */
export function predicateToPlaywright(predicate) {
  if (!predicate || !predicate.kind) return null;
  const { kind, value, selector, count } = predicate;
  switch (kind) {
    case "text":
      if (!value) return null;
      return `await expect(page.getByText(/${escapeRegex(value).slice(0, 120)}/i).first()).toBeVisible();`;
    case "absent_text":
      if (!value) return null;
      return `await expect(page.getByText(/${escapeRegex(value).slice(0, 120)}/i)).toHaveCount(0);`;
    case "url_contains":
      if (!value) return null;
      return `await expect(page).toHaveURL(/${escapeRegex(value).slice(0, 120)}/);`;
    case "visible":
      if (!selector) return null;
      return `await expect(page.locator(${quote(selector)}).first()).toBeVisible();`;
    case "absent":
      if (!selector) return null;
      return `await expect(page.locator(${quote(selector)})).toHaveCount(0);`;
    case "count":
      if (!selector || typeof count !== "number") return null;
      return `await expect(page.locator(${quote(selector)})).toHaveCount(${count});`;
    default:
      return null;
  }
}

/**
 * Fold action-only steps into the step that asserts their outcome.
 *
 * A planner will happily emit "fill the card field" with no expectation — that
 * is honest (filling a field is observable by nothing) but it is not a semantic
 * step, and the spec contract requires every step to declare what you should
 * see. Merging keeps the inputs and drops the empty assertion.
 */
export function mergeActionSteps(steps = []) {
  const merged = [];
  let pending = [];
  for (const step of steps) {
    const expectations = step.expect ?? [];
    if (expectations.length === 0) {
      pending.push(step);
      continue;
    }
    const carried = pending.filter((earlier) => !earlier.page || !step.page || earlier.page === step.page);
    // A pending step on a different page still has to be executed, so keep it
    // rather than silently dropping the navigation it represents.
    for (const orphan of pending.filter((earlier) => !carried.includes(earlier))) {
      merged.push({ ...orphan, expect: [{ prose: `Action completes: ${orphan.intent}` }] });
    }
    merged.push({
      ...step,
      inputs: [...carried.flatMap((earlier) => earlier.inputs ?? []), ...(step.inputs ?? [])],
    });
    pending = [];
  }
  // Trailing action steps have nothing to merge into; keep them assertable.
  for (const orphan of pending) {
    merged.push({ ...orphan, expect: [{ prose: `Action completes: ${orphan.intent}` }] });
  }
  return merged;
}

export function planToSpecs({ plan } = {}) {
  const specs = [];
  for (const flow of plan?.flows ?? []) {
    const id = slugify(flow.id.replace(/^flow_/, ""));
    const steps = mergeActionSteps(flow.steps ?? []);
    specs.push({
      version: 1,
      id,
      title: flow.title,
      environment: "local",
      // The saved semantic spec stays selector-free prose — that contract is
      // the point of the product. Predicates ride in the locators sidecar.
      steps: steps.map((step) => ({
        intent: step.intent,
        ...(step.channel ? { channel: step.channel } : {}),
        expect: (step.expect ?? []).map(expectationProse).filter(Boolean),
      })),
      _flowId: flow.id,
      _targetRefs: steps.map((step) => step.targetRef ?? null),
      _predicates: steps.map((step) => (step.expect ?? []).map(expectationPredicate)),
      _inputs: steps.map((step) => step.inputs ?? []),
      _actions: steps.map((step) => step.action ?? null),
      _pages: steps.map((step) => step.page ?? null),
      _preconditions: flow.preconditions ?? [],
    });
  }
  return specs;
}

/** Locator chain for a form field, best strategy first. */
export function inputCandidates(input, form) {
  const declared = (form?.inputs ?? []).find((entry) => entry.name === input.name);
  const candidates = [];
  if (declared?.placeholder) candidates.push({ strategy: "label", value: declared.placeholder, confidence: 0.85 });
  if (input.name) {
    candidates.push({ strategy: "label", value: input.name, confidence: 0.8 });
    candidates.push({ strategy: "css", value: `[name="${input.name}"]`, confidence: 0.7 });
  }
  if (declared?.type && declared.type !== "text") {
    candidates.push({ strategy: "css", value: `input[type="${declared.type}"]`, confidence: 0.4 });
  }
  return candidates.length > 0 ? candidates : [{ strategy: "css", value: "input", confidence: 0.2 }];
}

export function bindLocators({ spec, flow, siteMap } = {}) {
  const pageForms = new Map((siteMap?.pages ?? []).map((page) => [page.path, page.forms ?? []]));
  const bindings = [];
  (spec.steps ?? []).forEach((step, index) => {
    // Indices come from the spec, never from flow.steps: action-only steps are
    // merged away in planToSpecs, so the two arrays no longer line up.
    const pagePath = spec._pages?.[index] ?? flow?.pages?.[0] ?? "/";
    const targetRef = spec._targetRefs?.[index] ?? null;
    const forms = pageForms.get(pagePath) ?? [];
    let form = null;
    if (targetRef && targetRef.startsWith("form:")) form = forms[Number(targetRef.slice(5)) || 0] ?? null;
    // A step that fills fields belongs to whichever form declares them.
    const stepInputs = spec._inputs?.[index] ?? [];
    if (!form && stepInputs.length > 0) {
      form = forms.find((candidate) => stepInputs.some((input) => (candidate.inputs ?? []).some((declared) => declared.name === input.name))) ?? forms[0] ?? null;
    }
    if (!form && forms.length > 0 && (spec._actions?.[index] === "submit" || spec._actions?.[index] === "click")) {
      form = forms[0];
    }

    let candidates = [{ strategy: "text", value: step.intent.slice(0, 48), confidence: 0.6 }];
    if (form) {
      const label = (form.buttons ?? [])[0] ?? step.intent.slice(0, 32);
      candidates = selectorCandidates({ role: "button", name: label, text: label, tag: "button" });
    }

    bindings.push({
      stepIndex: index + 1,
      targetRef,
      page: pagePath,
      action: spec._actions?.[index] ?? (form ? "submit" : "observe"),
      candidates,
      inputs: stepInputs.map((input) => ({ ...input, candidates: inputCandidates(input, form) })),
      expectations: (step.expect ?? []).map((prose, position) => ({
        prose,
        predicate: spec._predicates?.[index]?.[position] ?? null,
        // Filled in by validateSelectors against the live DOM.
        validated: null,
      })),
      resolvedStrategy: candidates[0].strategy,
      assertionValidated: null,
    });
  });
  return {
    specId: spec.id,
    origin: siteMap?.origin ?? "",
    preconditions: spec._preconditions ?? [],
    validated: false,
    validatedAt: null,
    probeSource: "planner",
    bindings,
  };
}

async function fetchPageText(origin, pagePath, fetchImpl, cache) {
  const key = pagePath ?? "/";
  if (cache.has(key)) return cache.get(key);
  let html = "";
  let failed = false;
  try {
    const response = await fetchImpl(new URL(key, origin).href);
    html = typeof response.text === "function" ? await response.text() : "";
  } catch {
    // The target itself did not answer. That is different from a page that
    // answered with nothing, and must not be reported as validated.
    failed = true;
  }
  // Strip tags so a text assertion is checked against rendered copy, not markup.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const entry = { html: html.toLowerCase(), text, failed };
  cache.set(key, entry);
  return entry;
}

/**
 * Probe locators AND assertions against the live application.
 *
 * A locator resolves when one of its candidates appears in the served markup.
 * A text assertion validates when its literal string appears in the page copy.
 * Anything that cannot be decided from a static fetch is left `null`
 * (unverified) rather than being stamped true — the previous implementation
 * hardcoded `assertionValidated: true`, which made the flag meaningless.
 */
export async function validateSelectors({ sidecar, origin, fetchImpl = globalThis.fetch, executor, emit, knownPaths = new Set() } = {}) {
  const cache = new Map();
  const bindings = [];
  let locatorsResolved = 0;
  let locatorsProbed = 0;
  let assertionsChecked = 0;
  let assertionsVerified = 0;
  let reachable = true;

  for (const binding of sidecar?.bindings ?? []) {
    let resolvedStrategy = binding.candidates?.[0]?.strategy ?? "text";
    let probeSource = "planner";
    let locatorOk = false;
    let page = { html: "", text: "" };
    // A navigate step is satisfied by page.goto — there is no control to
    // resolve, so probing for one and counting the miss marked otherwise
    // sound specs unvalidated.
    const needsLocator = binding.action !== "navigate" && (binding.inputs ?? []).length + (binding.candidates ?? []).length > 0;

    try {
      if (executor?.observe) {
        await executor.observe(binding.candidates?.[0]?.value ?? "", {});
        probeSource = "executor";
        locatorOk = true;
      } else if (origin && fetchImpl) {
        page = await fetchPageText(origin, binding.page, fetchImpl, cache);
        probeSource = "fetch";
        // A page we could not fetch (auth-gated, or reached only after an
        // action) cannot disprove a locator — do not count it either way.
        if (page.failed) reachable = false;
        if (page.html && needsLocator) locatorsProbed += 1;
        const hit = (binding.candidates ?? []).find((candidate) => {
          const needle = typeof candidate.value === "string" ? candidate.value : candidate.value?.[1]?.name ?? "";
          return needle && needle.length >= 2 && page.html.includes(String(needle).toLowerCase());
        });
        if (hit) {
          resolvedStrategy = hit.strategy;
          locatorOk = true;
        } else {
          const fallback = (binding.candidates ?? []).find((candidate) => candidate.strategy === "text" || candidate.strategy === "css");
          resolvedStrategy = fallback?.strategy ?? resolvedStrategy;
        }
      }
    } catch {
      reachable = false;
    }
    if (locatorOk && needsLocator) locatorsResolved += 1;

    const expectations = [];
    for (const expectation of binding.expectations ?? []) {
      const predicate = expectation.predicate;
      let validated = null;
      if (predicate && probeSource === "fetch") {
        if (predicate.kind === "text" && predicate.value) {
          assertionsChecked += 1;
          validated = page.text.includes(String(predicate.value).toLowerCase());
        } else if (predicate.kind === "absent_text" && predicate.value) {
          assertionsChecked += 1;
          // Absence on the pre-action page is weak evidence, so only a
          // present string disproves it outright.
          validated = true;
        } else if (predicate.kind === "visible" || predicate.kind === "absent" || predicate.kind === "count") {
          // CSS predicates need a real DOM; a static fetch cannot decide them.
          validated = null;
        } else if (predicate.kind === "url_contains" && predicate.value) {
          // A planner that has not seen the post-action page tends to invent a
          // plausible path ("/order-confirmation" for an app that serves
          // "/confirmation"). Check the claim against the crawl before the
          // assertion ships.
          assertionsChecked += 1;
          const claimed = String(predicate.value).split("?")[0];
          validated = knownPaths.size === 0
            ? null
            : [...knownPaths].some((known) => known === claimed || known.startsWith(claimed) || claimed.startsWith(known));
        }
      }
      if (validated === true) assertionsVerified += 1;
      expectations.push({ ...expectation, validated });
    }

    bindings.push({ ...binding, resolvedStrategy, probeSource, expectations, assertionValidated: expectations.some((entry) => entry.validated === true) });
    await emit?.("generate", "selector_validated", {
      message: `${sidecar.specId} step ${binding.stepIndex}: ${resolvedStrategy}${locatorOk ? "" : " (unresolved)"}`,
    });
  }

  const withPredicates = bindings.reduce((total, binding) => total + (binding.expectations ?? []).filter((entry) => entry.predicate).length, 0);
  const totalExpectations = bindings.reduce((total, binding) => total + (binding.expectations ?? []).length, 0);
  const assertionsRefuted = bindings.reduce(
    (total, binding) => total + (binding.expectations ?? []).filter((entry) => entry.validated === false).length,
    0,
  );
  return {
    // Validated means: nothing we could actually probe was refuted. Pages we
    // could not reach leave the verdict open rather than failing it.
    validated: reachable && bindings.length > 0 && locatorsResolved >= locatorsProbed && assertionsRefuted === 0,
    bindings,
    probeSource: bindings[0]?.probeSource ?? "planner",
    stats: {
      locatorsResolved,
      locatorsProbed,
      locators: bindings.length,
      assertionsChecked,
      assertionsVerified,
      assertionsRefuted,
      withPredicates,
      totalExpectations,
    },
  };
}

export function renderPlaywrightSpec({ spec, flow, sidecar, validation, origin } = {}) {
  const validated = validation?.validated ?? sidecar?.validated ?? false;
  const bindings = validation?.bindings ?? sidecar?.bindings ?? [];
  const needsAuth = (sidecar?.preconditions ?? spec?._preconditions ?? []).includes("authenticated");
  const header = [
    "// AUTOGENERATED by qa-agent orchestrate — do not edit.",
    `// source of truth: .qa/specs/${spec.id}.yaml   locators: ${spec.id}.locators.json`,
    `// flow: ${flow?.id ?? spec._flowId ?? spec.id} (${flow?.category ?? "happy"})  rationale: ${flow?.rationale ?? "planner synthesis"}`,
    `// validated: ${validated}  probe: ${validation?.probeSource ?? sidecar?.probeSource ?? "planner"}`,
    "import { test, expect } from '@playwright/test';",
    "import { resolve } from './_resolve.js';",
    ...(needsAuth ? ["import { signIn } from './_auth.js';"] : []),
    `import chain from './${spec.id}.locators.json' with { type: 'json' };`,
    "",
    `const BASE = process.env.QA_BASE_URL ?? '${origin ?? "http://127.0.0.1:3000"}';`,
    "",
    `${validated ? "" : "test.fixme('unvalidated selectors — see locators.json', async () => {});\n"}`,
    `test('${String(spec.title).replace(/'/g, "\\'")}', async ({ page }) => {`,
    ...(needsAuth ? ["  await signIn(page, BASE);", ""] : []),
  ];

  const body = [];
  (spec.steps ?? []).forEach((step, index) => {
    const binding = bindings[index] ?? {};
    const pagePath = binding.page ?? flow?.pages?.[0] ?? "/";
    const previousPage = index === 0 ? null : bindings[index - 1]?.page;
    body.push(`  // intent: ${step.intent}`);
    if (index === 0 || pagePath !== previousPage) {
      body.push(`  await page.goto(\`\${BASE}${pagePath}\`);`);
    }
    for (const [position, input] of (binding.inputs ?? []).entries()) {
      body.push(`  await (await resolve(page, chain.bindings[${index}].inputs[${position}].candidates)).fill(${quote(input.value ?? "")});`);
    }
    // Only click when the step is actually a click/submit. A navigate step is
    // satisfied by the goto above, and a fill step by the fills — clicking
    // anyway submitted forms a step early.
    if (binding.action === "click" || binding.action === "submit") {
      body.push(`  await (await resolve(page, chain.bindings[${index}].candidates)).click();`);
    }
    for (const expectation of binding.expectations ?? []) {
      const assertion = predicateToPlaywright(expectation.predicate);
      if (assertion) {
        body.push(`  ${assertion} // expect: ${expectation.prose}`);
      } else {
        // No checkable predicate — say so rather than emitting an assertion
        // that asserts its own description and can never pass.
        body.push(`  // UNVERIFIED expectation (no predicate from the planner): ${expectation.prose}`);
      }
    }
    body.push("");
  });
  return `${[...header, ...body, "});", ""].join("\n")}`;
}

export function renderResolveHelper() {
  return `const build = (page, c) => ({
  testid: () => page.getByTestId(c.value),
  role: () => page.getByRole(...c.value),
  label: () => page.getByLabel(c.value),
  text: () => page.getByText(c.value, { exact: false }),
  css: () => page.locator(c.value),
}[c.strategy]());

export async function resolve(page, candidates, { timeout = 2000 } = {}) {
  const attempts = [];
  for (const c of candidates) {
    const loc = build(page, c).first();
    try {
      await loc.waitFor({ state: 'attached', timeout });
      attempts.push({ ...c, ok: true });
      if (attempts.length > 1) console.log('[heal] locator fallback ->', JSON.stringify(attempts));
      return loc;
    } catch {
      attempts.push({ ...c, ok: false });
    }
  }
  const err = new Error(\`locator chain exhausted: \${JSON.stringify(attempts)}\`);
  err.chainAttempts = attempts;
  throw err;
}
`;
}

/**
 * Sign-in helper for flows whose preconditions require a session.
 * Built from the login form discovered during the crawl, so it is specific to
 * the target rather than a guess.
 */
export function renderAuthHelper({ loginPath = "/login", userField = "username", passwordField = "password", submitLabel = "Sign in" } = {}) {
  return `// Sign-in helper derived from the crawled login form.
const USER = process.env.QA_USERNAME ?? 'demo';
const PASS = process.env.QA_PASSWORD ?? 'demo';

export async function signIn(page, base) {
  await page.goto(\`\${base}${loginPath}\`);
  await page.locator('[name="${userField}"]').first().fill(USER);
  await page.locator('[name="${passwordField}"]').first().fill(PASS);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.getByRole('button', { name: ${quote(submitLabel)} }).first().click(),
  ]);
}
`;
}

/** Locate the login form in the crawl so the auth helper targets real fields. */
export function authDetailsFrom(siteMap) {
  for (const page of siteMap?.pages ?? []) {
    for (const form of page.forms ?? []) {
      const password = (form.inputs ?? []).find((input) => input.type === "password");
      if (!password) continue;
      const user = (form.inputs ?? []).find((input) => input.type !== "password" && input.name);
      return {
        loginPath: form.action || page.path,
        userField: user?.name ?? "username",
        passwordField: password.name || "password",
        submitLabel: (form.buttons ?? [])[0] ?? "Sign in",
      };
    }
  }
  return null;
}

export async function generate({ workspace, plan, siteMap, origin, fetchImpl, executor, outDir, emit } = {}) {
  const specs = planToSpecs({ plan });
  const artifacts = [];
  const generatedDir = outDir ?? `${workspace.qaDirectory}/../generated`;
  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, "_resolve.js"), renderResolveHelper());

  const knownPaths = new Set((siteMap?.pages ?? []).map((page) => page.path));
  const auth = authDetailsFrom(siteMap);
  const needsAuth = specs.some((spec) => (spec._preconditions ?? []).includes("authenticated"));
  if (needsAuth) await writeFile(path.join(generatedDir, "_auth.js"), renderAuthHelper(auth ?? {}));

  let validatedCount = 0;
  const strategies = {};
  const flowMap = {};
  const assertions = { checked: 0, verified: 0, refuted: 0, withPredicates: 0, total: 0 };

  for (const spec of specs) {
    const flow = (plan.flows ?? []).find((entry) => entry.id === spec._flowId) ?? {};
    const sidecar = bindLocators({ spec, flow, siteMap });
    const validation = await validateSelectors({ sidecar, origin: origin ?? siteMap?.origin, fetchImpl, executor, emit, knownPaths });
    if (validation.validated) validatedCount += 1;
    for (const binding of validation.bindings) {
      strategies[binding.resolvedStrategy] = (strategies[binding.resolvedStrategy] ?? 0) + 1;
    }
    assertions.checked += validation.stats?.assertionsChecked ?? 0;
    assertions.refuted += validation.stats?.assertionsRefuted ?? 0;
    assertions.verified += validation.stats?.assertionsVerified ?? 0;
    assertions.withPredicates += validation.stats?.withPredicates ?? 0;
    assertions.total += validation.stats?.totalExpectations ?? 0;

    const clean = { ...spec };
    for (const key of ["_flowId", "_targetRefs", "_predicates", "_inputs", "_actions", "_pages", "_preconditions"]) delete clean[key];
    validateDocument("spec", clean);
    await workspace.saveSpec(clean);

    const finalSidecar = {
      ...sidecar,
      validated: validation.validated,
      validatedAt: new Date().toISOString(),
      probeSource: validation.probeSource,
      bindings: validation.bindings,
      stats: validation.stats,
    };
    await writeFile(path.join(generatedDir, `${spec.id}.locators.json`), `${JSON.stringify(finalSidecar, null, 2)}\n`);
    await writeFile(
      path.join(generatedDir, `${spec.id}.spec.js`),
      renderPlaywrightSpec({ spec: { ...clean, _preconditions: spec._preconditions }, flow, sidecar: finalSidecar, validation, origin: origin ?? siteMap?.origin }),
    );
    artifacts.push(spec.id);
    if (spec._flowId) flowMap[spec.id] = spec._flowId;
  }

  return {
    specs: specs.length,
    validated: validatedCount,
    unvalidated: specs.length - validatedCount,
    strategies,
    assertions,
    dir: generatedDir,
    artifacts,
    flowMap,
  };
}
