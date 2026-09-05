import assert from "node:assert/strict";
import test from "node:test";
import { authenticate, crawl } from "../src/planner.js";
import { CART_HTML, fakeFetch, HOME_HTML, LOGIN_HTML } from "../test-support/fake-fetch.js";

test("crawl discovers same-origin pages within caps and skips binaries", async () => {
  const fetchImpl = fakeFetch({
    "/": { html: `${HOME_HTML}<a href="/logo.png">img</a><a href="https://example.com">ext</a>` },
    "/login": { html: LOGIN_HTML },
    "/cart": { html: CART_HTML },
  });
  const siteMap = await crawl({ url: "http://127.0.0.1:4000/", fetchImpl, maxPages: 10, maxDepth: 2 });
  assert.equal(siteMap.origin, "http://127.0.0.1:4000");
  assert.ok(siteMap.pages.some((p) => p.path === "/"));
  assert.ok(siteMap.pages.some((p) => p.path === "/login"));
  assert.ok(siteMap.pages.some((p) => p.path === "/cart"));
  assert.ok(!siteMap.pages.some((p) => p.path.includes(".png")));
  assert.equal(siteMap.auth.authenticated, false);
});

test("crawl respects depth caps and tolerates fetch failures", async () => {
  const fetchImpl = fakeFetch({
    "/": { html: `<a href="/a">a</a>` },
    "/a": { html: `<a href="/b">b</a>` },
    "/b": { html: `<a href="/c">c</a>` },
  });
  const shallow = await crawl({ url: "http://127.0.0.1:4000/", fetchImpl, maxPages: 10, maxDepth: 1 });
  assert.ok(!shallow.pages.some((p) => p.path === "/b"));

  const flaky = async (target) => {
    if (String(target).endsWith("/boom")) throw new Error("down");
    return fakeFetch({ "/": { html: `<a href="/boom">x</a>` } })(target);
  };
  const survived = await crawl({ url: "http://127.0.0.1:4000/", fetchImpl: flaky });
  assert.equal(survived.pages.length, 1);
});

test("crawl requires a URL and captures auth cookies when credentials fit", async () => {
  await assert.rejects(() => crawl({}), /target URL is required/);
  const fetchImpl = fakeFetch({
    "/": { html: HOME_HTML },
    "/login": { html: LOGIN_HTML },
  });
  const authed = async (target, init = {}) => {
    if (String(target).endsWith("/login") && (init.method ?? "GET") === "POST") {
      return { status: 302, ok: false, headers: { get: (n) => (n === "set-cookie" ? "sid=1; Path=/" : null) }, text: async () => "" };
    }
    return fetchImpl(target, init);
  };
  const siteMap = await crawl({
    url: "http://127.0.0.1:4000/",
    fetchImpl: authed,
    credentials: { username: "u", password: "p" },
  });
  assert.equal(siteMap.auth.authenticated, true);
});

test("authenticate posts discovered field names and fails clearly", async () => {
  const ok = fakeFetch({});
  const loginPage = { forms: [{ action: "/login", inputs: [{ name: "email", type: "email" }, { name: "pw", type: "password" }] }] };
  const posted = [];
  const capture = async (target, init) => {
    posted.push(String(init.body));
    return { status: 302, headers: { get: () => "sid=1" } };
  };
  const result = await authenticate({ origin: "http://127.0.0.1:4000", page: loginPage, credentials: { username: "a", password: "b" }, fetchImpl: capture });
  assert.equal(result.authenticated, true);
  assert.match(posted[0], /email=a/);

  await assert.rejects(() => authenticate({ origin: "http://x", page: loginPage, credentials: {}, fetchImpl: ok }), /Username and password are required/);
  await assert.rejects(() => authenticate({ origin: "http://x", page: { forms: [] }, credentials: { username: "a", password: "b" }, fetchImpl: ok }), /No login form/);
  await assert.rejects(
    () => authenticate({ origin: "http://x", page: loginPage, credentials: { username: "a", password: "b" }, fetchImpl: fakeFetch({ "/login": { status: 401, html: "no" } }) }),
    /Authentication failed/,
  );
});
