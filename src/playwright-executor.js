// Playwright adapter for the NativeExecutor contract (dev/demo only).
//
// This heuristic adapter remains development/demo-only. The packaged runtime
// now owns a separate deterministic replay runner, so application projects do
// not install Playwright. Pass a real Playwright `page` object in here when
// exercising the semantic executor during repository development. The heuristics below are deterministic and
// deliberately dumb: first accessible match wins, observations are keyword
// containment, and anything ambiguous is reported, never guessed.
import { QaError } from "./errors.js";
import { createNativeWebExecutor } from "./native-executor.js";

function keywords(text) {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !new Set(["with", "from", "that", "this", "into", "your"]).has(w));
}

function bestName(intent, candidates) {
  const words = keywords(intent);
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const hay = String(candidate ?? "").toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (bestScore === 0) return { match: null, score: 0, total: words.length };
  return { match: best, score: bestScore, total: words.length };
}

export function createPlaywrightDriver({ page, baseUrl } = {}) {
  if (!page || typeof page.goto !== "function") {
    throw new QaError("INVALID_NATIVE_EXECUTOR", "createPlaywrightDriver requires a Playwright page with goto()");
  }
  const consoleErrors = [];
  const networkErrors = [];
  try {
    page.on?.("console", (message) => {
      if (message?.type?.() === "error") consoleErrors.push(String(message.text?.() ?? "console error").slice(0, 500));
    });
    page.on?.("requestfailed", (request) => {
      networkErrors.push(`${request?.method?.() ?? "GET"} ${request?.url?.() ?? ""}`.slice(0, 500));
    });
  } catch {}

  const snapshot = async () => {
    try {
      if (typeof page.content === "function") return String(await page.content());
    } catch {}
    try {
      if (typeof page.title === "function") return String(await page.title());
    } catch {}
    return "";
  };

  // Split the page into semantic blocks (headings, paragraphs, list items,
  // nav, title). Observations match against a SINGLE block, never a
  // bag-of-words across the whole page: matching "customer" from a heading
  // plus "dashboard" from the nav previously passed "Customer dashboard is
  // visible" on the login page (proven by screenshot, pass-variant run).
  const contentBlocks = (html) => {
    const source = String(html ?? "");
    const blocks = [];
    const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (title) blocks.push(title[1]);
    for (const match of source.matchAll(/<(h[1-6]|p|li|button|a|label|td|th)[^>]*>([\s\S]*?)<\/\1>/gi)) {
      blocks.push(match[2]);
    }
    return blocks
      .map((block) => block.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase())
      .filter((block) => block.length > 0)
      .slice(0, 200);
  };

  const blockScore = (blocks, words) => {
    let best = { hits: 0, block: "" };
    for (const block of blocks) {
      const hits = words.filter((w) => block.includes(w)).length;
      if (hits > best.hits) best = { hits, block };
    }
    return best;
  };

  const findAction = async (intent) => {
    const html = await snapshot();
    const links = [...html.matchAll(/<a[^>]+href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1] ?? m[2] ?? "", text: m[3].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() })).filter((l) => l.text);
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/gi)].map((m) => ({ attrs: m[1] ?? "", text: m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() })).filter((b) => b.text);
    const buttonNames = buttons.map((b) => b.text).slice(0, 40);
    const submits = buttons.filter((b) => /type\s*=\s*(?:"submit"|'submit'|submit)/i.test(b.attrs)).map((b) => b.text);
    const { match, score, total } = bestName(intent, [...links.map((l) => l.text), ...buttonNames]);
    // Locator chain evidence: record which strategies could resolve the
    // matched control. testid-first ordering mirrors the generated sidecars;
    // when a redesign drops the testid, the role/text fallback — and the
    // receipt that it happened — is the resilience story.
    const testidFor = (text) => {
      const button = buttons.find((b) => b.text === text);
      const fromButton = button?.attrs.match(/data-testid\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (fromButton) return fromButton[1] ?? fromButton[2];
      return null;
    };
    // Single-submit fallback: on a page with exactly one submit button, an
    // intent like "Submit leaving card blank" names the test setup, not the
    // control. Guessing across multiple buttons would be dishonest; with one
    // candidate the primary action is unambiguous. Never apply it to a
    // navigation-shaped intent ("Open …") — e.g. "Open the login page" would
    // otherwise resolve to that page's lone "Sign in" submit button and
    // click it a step early, before credentials are meant to be entered.
    const isNavigationIntent = /^(open|view|go to)\b/i.test(intent);
    const fallback = !match && !isNavigationIntent && submits.length === 1 ? submits[0] : null;
    // Fuzzy-match receipt: a partial keyword overlap (e.g. "Proceed to
    // checkout" resolving to a renamed "Continue to payment") is drift
    // absorbed, and the receipt names it. Exact matches stay clean. Display
    // text carries the receipt; rawMatch stays exact for link/button lookup.
    const fuzzy = match && total > 1 && score < total ? ` (fuzzy ${score}/${total})` : "";
    const rawMatch = match ?? fallback;
    return { html, links, buttons: buttonNames, match: rawMatch, display: rawMatch ? `${rawMatch}${match ? fuzzy : ""}` : rawMatch, fallback: Boolean(!match && fallback), testidFor };
  };

  const clearInputs = async (preserved = new Set()) => {
    for (const selector of [`input[type="text"]`, `input[type="email"]`, `input[type="password"]`, `input:not([type])`, `textarea`] ) {
      try {
        const locator = page.locator(selector);
        const count = await locator.count();
        for (let index = 0; index < Math.min(count, 10); index += 1) {
          const field = locator.nth(index);
          let name = "";
          try {
            name = String(await field.getAttribute("name") ?? "");
          } catch {}
          if (name && preserved.has(name)) continue;
          await field.fill("");
        }
      } catch {}
    }
  };

  // Form state filled by between-step fixtures (e.g. a test card number)
  // must survive until the submit step: clearing it would undefeatably break
  // the flow the fixture exists to set up. Before-fixture fills (login) are
  // NOT preserved — the session cookie carries authentication, and stale
  // credentials would corrupt negative tests. Reset on navigation.
  let preservedInputs = new Set();
  let preservedUrl = "";
  const noteNavigation = () => {
    try {
      const current = page.url();
      if (current !== preservedUrl) {
        preservedUrl = current;
        preservedInputs = new Set();
      }
    } catch {}
  };

  const fillInputs = async (inputs = {}, phase) => {
    const filled = [];
    for (const [name, value] of Object.entries(inputs)) {
      if (value === undefined || value === null || String(value) === "") continue;
      const selectors = [`input[name="${name}"]`, `input[id="${name}"]`, `textarea[name="${name}"]`];
      for (const selector of selectors) {
        try {
          const locator = page.locator(selector).first();
          await locator.waitFor({ state: "attached", timeout: 1500 });
          await locator.fill(String(value));
          filled.push(name);
          if (phase && phase !== "before") preservedInputs.add(name);
          break;
        } catch {}
      }
    }
    return filled;
  };

  return createNativeWebExecutor({
    isAvailable: () => ({ available: true }),
    async connect(target) {
      await page.goto(target?.baseUrl ?? baseUrl ?? "about:blank");
    },
    async act(intent, context) {
      // No auto-navigation: fixtures establish state (login lands on the
      // dashboard) and blindly returning to baseUrl on step 1 discards it —
      // every spec then acted on the login form. connect() navigates once.
      // Fixture credentials arrive as context.inputs — fill them before
      // touching any submit control. Without this the adapter clicks "Sign
      // in" with empty fields and can never authenticate.
      // Test-scope steps carry no inputs: clear first so a previous spec's
      // filled values cannot leak across (e.g. "invalid credentials" must
      // really submit empty/invalid fields, not stale valid ones).
      noteNavigation();
      if (context?.scope === "test") await clearInputs(preservedInputs);
      const filled = await fillInputs(context?.inputs, context?.phase);
      const { links, buttons, match: rawMatch, display: match, testidFor } = await findAction(intent);
      const isNav = /^(open|view|go to)\b/i.test(intent);
      // Link-text-first navigation: when the matched text is a link, follow
      // it — either the intent is navigational, or no button bears that exact
      // text (e.g. journey step "Proceed to checkout" naming a link).
      // Clicking a same-named button remains the fallback below.
      const link = links.find((entry) => entry.text === rawMatch);
      const buttonExists = buttons.some((name) => name === rawMatch);
      if (link?.href && (isNav || !buttonExists)) {
        try {
          await page.goto(new URL(link.href, page.url()).href);
          return { selectedTarget: { summary: match, role: "link", name: match } };
        } catch {}
      }
      // No link to follow but the target state may already be displayed
      // (e.g. "Open the shopping cart" while its heading is on screen, or
      // "Open the login page" while a login form is displayed). Clicking
      // again would resubmit or wander, so report success when shown.
      // Idempotent sign-in: a bare "Sign in" / "Log in" intent while the
      // dashboard is already displayed means the session persisted.
      // Negative variants ("invalid", "empty", …) are excluded so negative
      // tests really submit instead of no-op'ing.
      if (isNav && !link?.href) {
        const html = await snapshot();
        if (/login|sign.?in/i.test(intent) && /type\s*=\s*(?:"password"|'password'|password)/i.test(html)) {
          return { selectedTarget: { summary: `Already showing: ${intent}`, role: "document", name: intent } };
        }
        const rest = keywords(intent.replace(/^(open|view|go to)\b/i, "").replace(/^the\b/i, "")).map((w) => w.replace(/^\//, ""));
        if (rest.length > 0) {
          const blocks = contentBlocks(html);
          const { hits } = blockScore(blocks, rest);
          if (hits / rest.length >= 0.6) {
            return { selectedTarget: { summary: `Already showing: ${intent}`, role: "document", name: intent } };
          }
        }
      }
      // Idempotent sign-in: a bare "Sign in" / "Log in" intent while the
      // dashboard is already displayed means the session persisted — report
      // success without resubmitting. MUST run before the no-match return:
      // an authed dashboard has no sign-in control to match. Negative
      // variants ("invalid", "empty", "blank", …) are excluded so negative
      // tests really submit instead of no-op'ing.
      if (/^(sign.?in|log.?in)(\s+via\s+.*)?$/i.test(intent.trim()) && !/invalid|empty|blank|wrong|bad|incorrect/i.test(intent)) {
        const authed = await snapshot();
        if (/customer dashboard/i.test(authed)) {
          return { selectedTarget: { summary: `Already signed in: ${intent}`, role: "document", name: intent } };
        }
      }
      // Data-entry intents ("Enter …", "Fill …") fill and stop: inputs come
      // from fixture context, not page matching, so this runs BEFORE the
      // no-match return. Submitting here would fire a half-specified form
      // (entering a test card must not place the order).
      if (/^(enter|fill|type|provide)\b/i.test(intent)) {
        if (filled.length > 0) {
          return { selectedTarget: { summary: `filled ${filled.join(", ")}`, role: "textbox", name: filled[0] } };
        }
      }
      if (!match) {
        return { status: "failed", observation: `No actionable control matched intent: ${intent}`, selectedTarget: { summary: `Unmatched intent: ${intent}` } };
      }
      try {
        // Chain-ordered click: testid first (stable across copy changes),
        // then role, then text. Attempts are recorded in the observation
        // trail so a drifted redesign leaves a receipt, not a mystery.
        const testid = testidFor(rawMatch);
        const attempts = [];
        let clicked = null;
        if (testid && page.getByTestId) {
          try {
            const locator = page.getByTestId(testid).first();
            await locator.waitFor({ state: "attached", timeout: 1200 });
            await locator.click({ timeout: 2000 });
            clicked = `testid=${testid}`;
          } catch {
            attempts.push(`testid=${testid}:miss`);
          }
        } else if (testid) {
          attempts.push(`testid=${testid}:unsupported`);
        }
        if (!clicked) {
          try {
            const locator = page.getByRole ? page.getByRole("button", { name: rawMatch }).first() : page.locator(`text=${rawMatch}`).first();
            const fallback = locator ?? page.locator(`text=${rawMatch}`).first();
            await fallback.click({ timeout: 2000 });
            clicked = `role=${rawMatch}`;
          } catch (error) {
            return { status: "failed", observation: `Matched "${match}" but click failed: ${error.message}`, selectedTarget: { summary: match, role: "button", name: rawMatch } };
          }
        }
        const filledNote = filled.length > 0 ? ` (filled ${filled.join(", ")})` : "";
        const chainNote = attempts.length > 0 ? ` [chain: ${[...attempts, clicked].join(" -> ")}]` : "";
        return { selectedTarget: { summary: `${match}${filledNote}${chainNote}`, role: "button", name: rawMatch } };
      } catch (error) {
        return { status: "failed", observation: `Matched "${match}" but click failed: ${error.message}`, selectedTarget: { summary: match, role: "button", name: rawMatch } };
      }
    },
    async observe(expectation) {
      const blocks = contentBlocks(await snapshot());
      // Negated expectations ("No error …", "… is absent", "No record …")
      // pass when no SINGLE block contains the positive phrase.
      const negation = expectation.match(/^\s*no\s+(.+?)(?:\s+is\s+(?:shown|visible|created))?\s*$/i);
      const absent = expectation.match(/(.+?)\s+is\s+absent\s*$/i);
      const positive = (absent?.[1] ?? negation?.[1] ?? "").trim();
      if (positive) {
        const words = keywords(positive).filter((w) => !w.startsWith("/"));
        if (words.length === 0) return { status: "passed", observation: expectation };
        const { hits } = blockScore(blocks, words);
        const violated = hits / words.length >= 0.5;
        return { status: violated ? "failed" : "passed", observation: violated ? `${expectation} — violated` : expectation };
      }
      const words = keywords(expectation).map((w) => w.replace(/^\//, "")).filter((w) => w.length > 2);
      if (words.length === 0) return { status: "passed", observation: expectation };
      const { hits } = blockScore(blocks, words);
      const passed = hits / words.length >= 0.6;
      return { status: passed ? "passed" : "failed", observation: passed ? expectation : `${expectation} was not observed (${hits}/${words.length} keywords in best block)` };
    },
    async screenshot() {
      const data = await page.screenshot({ type: "png" });
      return { data, extension: "png" };
    },
    async rediscover(intent) {
      const { match } = await findAction(intent);
      if (!match) return { status: "not_found", explanation: `No equivalent control for ${intent}` };
      return { status: "found", equivalent: true, target: { summary: match, role: "button", name: match }, observation: `Rediscovered "${match}" for intent` };
    },
    async recover(intent, target) {
      try {
        const locator = page.getByRole ? page.getByRole("button", { name: target?.name ?? target?.summary }).first() : page.locator(`text=${target?.name ?? ""}`).first();
        await locator.click({ timeout: 2000 });
        return { selectedTarget: { summary: target?.summary ?? intent, role: "button", name: target?.name ?? target?.summary ?? intent } };
      } catch (error) {
        return { status: "failed", observation: `Recovery click failed: ${error.message}` };
      }
    },
    async waitFor(expectation) {
      const result = await this.observe(expectation);
      return result;
    },
    consoleErrors: async () => [...consoleErrors],
    networkErrors: async () => [...networkErrors],
  });
}
