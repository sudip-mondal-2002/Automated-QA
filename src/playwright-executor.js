// Playwright adapter for the NativeExecutor contract (dev/demo only).
//
// NOT part of the bundled skill runtime: skill-runtime.js never imports this
// file, so `ajv+yaml` stays the production dep floor. Install as a dev
// dependency (`npm install --save-dev @playwright/test`) and pass a real
// Playwright `page` object in. The heuristics below are deterministic and
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
  return bestScore > 0 ? best : null;
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

  const contentWords = (html) => String(html ?? "").toLowerCase().replace(/<[^>]*>/g, " ");

  const findAction = async (intent) => {
    const html = await snapshot();
    const links = [...html.matchAll(/<a[^>]+href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1] ?? m[2] ?? "", text: m[3].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() })).filter((l) => l.text);
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 40);
    const submits = [...html.matchAll(/<button[^>]*type\s*=\s*(?:"submit"|'submit'|submit)[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    const match = bestName(intent, [...links.map((l) => l.text), ...buttons]);
    // Single-submit fallback: on a page with exactly one submit button, an
    // intent like "Submit leaving card blank" names the test setup, not the
    // control. Guessing across multiple buttons would be dishonest; with one
    // candidate the primary action is unambiguous.
    const fallback = !match && submits.length === 1 ? submits[0] : null;
    return { html, links, buttons, match: match ?? fallback, fallback: Boolean(!match && fallback) };
  };

  const clearInputs = async () => {
    for (const selector of [`input[type="text"]`, `input[type="email"]`, `input[type="password"]`, `input:not([type])`, `textarea`] ) {
      try {
        const locator = page.locator(selector);
        const count = await locator.count();
        for (let index = 0; index < Math.min(count, 10); index += 1) {
          await locator.nth(index).fill("");
        }
      } catch {}
    }
  };

  const fillInputs = async (inputs = {}) => {
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
      const targetUrl = context?.target?.baseUrl ?? baseUrl;
      if (targetUrl && context?.stepIndex === 1) {
        try {
          await page.goto(targetUrl);
        } catch {}
      }
      // Fixture credentials arrive as context.inputs — fill them before
      // touching any submit control. Without this the adapter clicks "Sign
      // in" with empty fields and can never authenticate.
      // Test-scope steps carry no inputs: clear first so a previous spec's
      // filled values cannot leak across (e.g. "invalid credentials" must
      // really submit empty/invalid fields, not stale valid ones).
      if (context?.scope === "test") await clearInputs();
      const filled = await fillInputs(context?.inputs);
      const { links, buttons, match } = await findAction(intent);
      if (!match) {
        return { status: "failed", observation: `No actionable control matched intent: ${intent}`, selectedTarget: { summary: `Unmatched intent: ${intent}` } };
      }
      // Navigation intents ("Open …", "View …") prefer links: clicking a
      // submit button with the same words would POST a half-filled form.
      const link = links.find((entry) => entry.text === match);
      if (/^(open|view|go to)\b/i.test(intent) && link?.href) {
        try {
          await page.goto(new URL(link.href, page.url()).href);
          return { selectedTarget: { summary: match, role: "link", name: match } };
        } catch {}
      }
      try {
        const locator = page.getByRole ? page.getByRole("button", { name: match }).first() : page.locator(`text=${match}`).first();
        const fallback = locator ?? page.locator(`text=${match}`).first();
        await fallback.click({ timeout: 2000 });
        const note = filled.length > 0 ? ` (filled ${filled.join(", ")})` : "";
        return { selectedTarget: { summary: `${match}${note}`, role: "button", name: match } };
      } catch (error) {
        return { status: "failed", observation: `Matched "${match}" but click failed: ${error.message}`, selectedTarget: { summary: match, role: "button", name: match } };
      }
    },
    async observe(expectation) {
      const text = contentWords(await snapshot());
      // Negated expectations ("No error …", "… is absent", "No record …")
      // pass when the positive phrase is absent from the page.
      const negation = expectation.match(/^\s*no\s+(.+?)(?:\s+is\s+(?:shown|visible|created))?\s*$/i);
      const absent = expectation.match(/(.+?)\s+is\s+absent\s*$/i);
      const positive = (absent?.[1] ?? negation?.[1] ?? "").trim();
      if (positive) {
        const words = keywords(positive).filter((w) => !w.startsWith("/"));
        if (words.length === 0) return { status: "passed", observation: expectation };
        const hits = words.filter((w) => text.includes(w)).length;
        const violated = hits / words.length >= 0.5;
        return { status: violated ? "failed" : "passed", observation: violated ? `${expectation} — violated` : expectation };
      }
      const words = keywords(expectation).map((w) => w.replace(/^\//, "")).filter((w) => w.length > 2);
      if (words.length === 0) return { status: "passed", observation: expectation };
      const hits = words.filter((w) => text.includes(w)).length;
      const passed = hits / words.length >= 0.5;
      return { status: passed ? "passed" : "failed", observation: passed ? expectation : `${expectation} was not observed (${hits}/${words.length} keywords)` };
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
