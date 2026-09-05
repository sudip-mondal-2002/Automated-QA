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

test("crawl overlaps independent siblings but preserves breadth-first evidence order", async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async (target) => {
    const path = new URL(String(target)).pathname;
    active += 1;
    peak = Math.max(peak, active);
    if (path !== "/") await new Promise((resolve) => setTimeout(resolve, path === "/a" ? 15 : 5));
    active -= 1;
    const html = path === "/" ? `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>` : `<h1>${path}</h1>`;
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => html };
  };

  const siteMap = await crawl({ url: "http://127.0.0.1:4000/", fetchImpl, concurrency: 3 });
  assert.ok(peak >= 3);
  assert.deepEqual(siteMap.pages.map((page) => page.path), ["/", "/a", "/b", "/c"]);
});

test("crawl finishes one breadth-first depth before fetching the next", async () => {
  let markCStarted;
  let releaseC;
  let deepStarted = false;
  const cStarted = new Promise((resolve) => { markCStarted = resolve; });
  const cCanFinish = new Promise((resolve) => { releaseC = resolve; });
  const fetchImpl = async (target) => {
    const path = new URL(String(target)).pathname;
    if (path === "/c") {
      markCStarted();
      await cCanFinish;
    }
    if (path === "/deep") deepStarted = true;
    const html = path === "/"
      ? `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`
      : path === "/a" ? `<a href="/deep">deep</a>` : `<h1>${path}</h1>`;
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => html };
  };

  const pending = crawl({ url: "http://127.0.0.1:4000/", fetchImpl, concurrency: 2 });
  await cStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deepStarted, false);
  releaseC();
  const siteMap = await pending;
  assert.deepEqual(siteMap.pages.map((page) => page.path), ["/", "/a", "/b", "/c", "/deep"]);
});

test("crawl consumes a readiness snapshot instead of fetching the first page again", async () => {
  const calls = [];
  const fetchImpl = async (target) => {
    calls.push(new URL(String(target)).pathname);
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => "<h1>Next</h1>" };
  };
  const response = { status: 200, ok: true, headers: { get: () => null }, text: async () => { throw new Error("already consumed"); } };
  const siteMap = await crawl({
    url: "http://127.0.0.1:4000/",
    fetchImpl,
    initialPage: { path: "/", response, html: `<h1>Home</h1><a href="/next">Next</a>` },
  });
  assert.deepEqual(calls, ["/next"]);
  assert.deepEqual(siteMap.pages.map((page) => page.path), ["/", "/next"]);
});

test("crawl refetches a manual redirect probe instead of treating its empty body as the landing page", async () => {
  const calls = [];
  const fetchImpl = async (target) => {
    calls.push(new URL(String(target)).pathname);
    return { status: 200, ok: true, url: "http://127.0.0.1:4000/login", headers: { get: () => null }, text: async () => LOGIN_HTML };
  };
  const redirect = { status: 303, ok: false, headers: { get: (name) => name === "location" ? "/login" : null }, text: async () => "" };
  const siteMap = await crawl({
    url: "http://127.0.0.1:4000/",
    fetchImpl,
    initialPage: { path: "/", response: redirect, html: "" },
  });
  assert.deepEqual(calls, ["/"]);
  assert.equal(siteMap.pages[0].path, "/login");
  assert.equal(siteMap.pages[0].headings[0].text, "Customer sign in");
  assert.equal(siteMap.pages[0].forms.length, 1);
});

test("an authenticated readiness snapshot seeds protected sibling discovery", async () => {
  const calls = [];
  const fetchImpl = async (target, init = {}) => {
    const path = new URL(String(target)).pathname;
    calls.push({ path, method: init.method ?? "GET", cookie: init.headers?.cookie ?? "" });
    if (path === "/login" && init.method === "POST") {
      return { status: 302, ok: false, headers: { get: (name) => name === "set-cookie" ? "sid=auth; Path=/" : null }, text: async () => "" };
    }
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => "<h1>Private</h1>" };
  };
  const response = { status: 200, ok: true, headers: { get: () => null }, text: async () => "" };
  const siteMap = await crawl({
    url: "http://127.0.0.1:4000/",
    credentials: { username: "user", password: "pass" },
    fetchImpl,
    initialPage: {
      path: "/",
      response,
      html: `<form action="/login"><input name="username"><input name="password" type="password"><button>Sign in</button></form><a href="/private">Private</a>`,
    },
  });
  assert.equal(siteMap.auth.authenticated, true);
  assert.ok(calls.some((call) => call.path === "/private" && call.cookie === "sid=auth"));
  assert.ok(!calls.some((call) => call.path === "/"));
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
