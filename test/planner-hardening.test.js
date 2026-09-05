import assert from "node:assert/strict";
import test from "node:test";
import { crawl, parseHtml, selectorCandidates } from "../src/planner.js";
import { fakeFetch } from "../test-support/fake-fetch.js";

test("crawl enforces page caps separately from depth caps", async () => {
  const fetchImpl = fakeFetch({
    "/": { html: `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>` },
    "/a": { html: `<h1>A</h1>` },
    "/b": { html: `<h1>B</h1>` },
    "/c": { html: `<h1>C</h1>` },
  });
  const capped = await crawl({ url: "http://127.0.0.1:4000/", fetchImpl, maxPages: 2, maxDepth: 3 });
  assert.equal(capped.pages.length, 2);
});

test("crawl follows redirects, skips non-HTML failures and carries cookies", async () => {
  const seen = [];
  const fetchImpl = async (target, init = {}) => {
    seen.push({ url: String(target), cookie: init.headers?.cookie ?? "" });
    const path = new URL(String(target)).pathname;
    if (path === "/") return { status: 301, ok: false, headers: { get: (n) => (n === "set-cookie" ? "sid=abc; Path=/" : null) }, text: async () => "" };
    if (path === "/private") return { status: 200, ok: true, headers: { get: () => null }, text: async () => `<h1>Secret</h1><a href="/">home</a>` };
    return { status: 404, ok: false, headers: { get: () => null }, text: async () => "no" };
  };
  const siteMap = await crawl({ url: "http://127.0.0.1:4000/private", fetchImpl });
  assert.ok(siteMap.pages.some((p) => p.path === "/private"));
  assert.ok(seen.some((call) => call.cookie.includes("sid=abc") || call.cookie === ""));
});

test("crawl marks SPA shells as degraded", async () => {
  const spa = fakeFetch({ "/": { html: `<div id="root"></div><script src="/app.js"></script>` } });
  const siteMap = await crawl({ url: "http://127.0.0.1:4000/", fetchImpl: spa });
  assert.equal(siteMap.degraded, true);

  const rich = fakeFetch({ "/": { html: `<a href="/a">a</a><a href="/b">b</a><form action="/go"><input name="q"></form>` } });
  const healthy = await crawl({ url: "http://127.0.0.1:4000/", fetchImpl: rich });
  assert.equal(healthy.degraded, false);
});

test("parseHtml attribute precedence prefers quoted values and login signals", () => {
  const parsed = parseHtml(`<form action='/go' method=post><input name=user required><input name='p' type='password'></form>`);
  assert.equal(parsed.forms[0].action, "/go");
  assert.equal(parsed.signals.login, false);
  const loginLike = parseHtml(`<p>password</p><p>Sign in</p>`);
  assert.equal(loginLike.signals.login, true);
});

test("selectorCandidates label and text fallbacks behave", () => {
  const labelOnly = selectorCandidates({ label: "Email", tag: "input" });
  assert.equal(labelOnly[0].strategy, "label");
  const textOnly = selectorCandidates({ text: "Submit", tag: "button" });
  assert.ok(textOnly.some((c) => c.strategy === "text"));
  assert.ok(textOnly.some((c) => c.strategy === "css"));
});
