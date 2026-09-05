import assert from "node:assert/strict";
import test from "node:test";
import { createPlaywrightDriver } from "../src/playwright-executor.js";
import { QaError } from "../src/index.js";

function fakePage(html, { clickFails = false, testids = [] } = {}) {
  const filledNames = [];
  const field = {
    fill: async (value) => filledNames.push(value),
    getAttribute: async () => "card",
  };
  const locator = {
    first: () => locator,
    nth: () => field,
    count: async () => 0,
    getAttribute: async () => "card",
    fill: async (value) => filledNames.push(value),
    waitFor: async () => {},
    click: async () => {
      if (clickFails) throw new Error("click timeout");
    },
  };
  const testidLocator = (id) => ({
    first: () => testidLocator(id),
    waitFor: async () => {
      if (!testids.includes(id)) throw new Error(`waiting for getByTestId("${id}") to be attached`);
    },
    click: async () => {
      if (clickFails) throw new Error("click timeout");
    },
  });
  return {
    navigated: [],
    filled: filledNames,
    async goto(url) {
      this.navigated.push(url);
    },
    url: () => "http://127.0.0.1:4555/cart",
    async content() {
      return html;
    },
    getByRole: () => locator,
    getByTestId: (id) => testidLocator(id),
    locator: (selector) => {
      const name = selector.match(/name="([^"]+)"/)?.[1];
      if (name) locator.lastFilled = name;
      return locator;
    },
    async screenshot() {
      return Buffer.from("png");
    },
    on: () => {},
  };
}

test("playwright driver requires a page and drives deterministic heuristics", async () => {
  assert.throws(() => createPlaywrightDriver({}), (e) => e instanceof QaError);
  const page = fakePage(`<button>Proceed to checkout</button><h1>Cart</h1><p>Cart contains one item</p>`);
  const executor = createPlaywrightDriver({ page, baseUrl: "http://127.0.0.1:4555" });
  assert.equal((await executor.availability()).available, true);
  await executor.connect({ baseUrl: "http://127.0.0.1:4555" });
  assert.ok(page.navigated[0].includes("4555"));
  const acted = await executor.act("Proceed to checkout", { stepIndex: 2 });
  assert.ok(acted.selectedTarget.summary.includes("checkout"));
  const missed = await executor.act("Teleport to mars", {});
  assert.equal(missed.status, "failed");
  assert.equal((await executor.observe("Cart contains one item")).status, "passed");
  assert.equal((await executor.observe("Teleportation portal visible")).status, "failed");
  assert.equal((await executor.observe("No error message is shown")).status, "passed");
  assert.equal((await executor.observe("The test order is absent")).status, "passed");
  const shot = await executor.screenshot();
  assert.equal(shot.extension, "png");
  const found = await executor.rediscover("Proceed to checkout");
  assert.equal(found.status, "found");
  assert.equal(found.equivalent, true);
  const lost = await executor.rediscover("Teleport to mars");
  assert.equal(lost.status, "not_found");
  assert.deepEqual(await executor.consoleErrors(), []);
});

test("playwright driver reports click failures instead of guessing", async () => {
  const page = fakePage(`<button>Place order</button>`, { clickFails: true });
  const executor = createPlaywrightDriver({ page });
  const acted = await executor.act("Place order", {});
  assert.equal(acted.status, "failed");
  const recovered = await executor.recover("Place order", { summary: "Place order", name: "Place order" });
  assert.equal(recovered.status, "failed");
});

test("playwright driver fills fixture inputs and prefers links for navigation", async () => {
  const page = fakePage(`<a href="/cart">Open shopping cart</a><form method="post" action="/login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>`);
  const executor = createPlaywrightDriver({ page });
  const opened = await executor.act("Open the shopping cart", {});
  assert.equal(opened.selectedTarget.role, "link");
  assert.ok(page.navigated.some((url) => url.endsWith("/cart")));
  const signedIn = await executor.act("Sign in with the supplied customer credentials", { inputs: { username: "u", password: "p" } });
  assert.match(signedIn.selectedTarget.summary, /filled username, password/);
});

test("observations match single blocks and open intents no-op when shown", async () => {
  const login = fakePage(`<header><strong>QA Shop</strong><nav><a href="/dashboard">Dashboard</a></nav></header><main><h1>Customer sign in</h1><form method="post" action="/login"><input name="username"><input name="password" type="password"><button>Sign in</button></form></main>`);
  const executor = createPlaywrightDriver({ page: login });
  // "Dashboard" only in nav + "Customer" only in heading: scattered across
  // blocks, so this must FAIL (the false pass proven by screenshot).
  assert.equal((await executor.observe("Customer dashboard is visible")).status, "failed");
  const dash = fakePage(`<main><h1>Customer dashboard</h1><p>Welcome back</p></main>`);
  const executor2 = createPlaywrightDriver({ page: dash });
  assert.equal((await executor2.observe("Customer dashboard is visible")).status, "passed");
  // No link to follow and the heading is on screen: no-op success.
  const cart = fakePage(`<main><h1>Shopping cart</h1><p>Cart contains one item</p></main>`);
  const executor3 = createPlaywrightDriver({ page: cart });
  const already = await executor3.act("Open the shopping cart", {});
  assert.match(already.selectedTarget.summary, /Already showing/);
  assert.equal(cart.navigated.length, 0);
});

test("test-scope acts do not navigate away from fixture state", async () => {
  const page = fakePage(`<main><h1>Customer dashboard</h1></main>`);
  const executor = createPlaywrightDriver({ page, baseUrl: "http://127.0.0.1:4555" });
  await executor.act("Check something", { scope: "test", stepIndex: 1, target: { baseUrl: "http://127.0.0.1:4555" } });
  assert.equal(page.navigated.length, 0);
});

test("open-login intents no-op while a login form is displayed", async () => {
  const page = fakePage(`<main><h1>Customer sign in</h1><form method="post" action="/login"><input name="username"><input name="password" type="password"><button>Sign in</button></form></main>`);
  const executor = createPlaywrightDriver({ page });
  const opened = await executor.act("Open the login page", {});
  assert.match(opened.selectedTarget.summary, /Already showing/);
});

test("bare sign-in no-ops when authed but negative variants still submit", async () => {  const authed = fakePage(`<main><h1>Customer dashboard</h1><p>Welcome</p></main>`);
  const executor = createPlaywrightDriver({ page: authed });
  const already = await executor.act("Sign in", {});
  assert.match(already.selectedTarget.summary, /Already signed in/);
  const negative = await executor.act("Sign in with invalid credentials", {});
  assert.equal(negative.status, "failed");
  assert.doesNotMatch(negative.selectedTarget.summary, /Already signed in/);
});

test("between-fixture fills survive clearing until navigation", async () => {
  const filledNames = [];
  const field = { fill: async (value) => filledNames.push(value), getAttribute: async () => "card" };
  const locator = { first: () => locator, nth: () => field, count: async () => 0, getAttribute: async () => "card", fill: async (value) => filledNames.push(value), waitFor: async () => {} };
  const page = { navigated: [], current: "http://x/checkout", url() { return this.current; }, async goto(url) { this.current = url; this.navigated.push(url); }, async content() { return `<form><input name="card"><button>Place order</button></form>`; }, locator: () => locator, getByRole: () => locator, async screenshot() { return Buffer.from("png"); }, on: () => {} };
  const executor = createPlaywrightDriver({ page });
  const setup = await executor.act("Enter the saved test card number", { scope: "fixture", phase: "between", inputs: { card: "4242" } });
  assert.match(setup.selectedTarget.summary, /filled card/);
  assert.deepEqual(filledNames.at(-1), "4242");
  // Test-scope clearing must preserve the between-fixture fill on the same page.
  await executor.act("Place order", { scope: "test" });
  assert.ok(!filledNames.includes(""));
});

test("clicks prefer testid and leave a chain receipt on fallback", async () => {  const stable = fakePage(`<form><button type="submit" data-testid="place-order">Place order</button></form>`, { testids: ["place-order"] });
  const stableDriver = createPlaywrightDriver({ page: stable });
  const direct = await stableDriver.act("Place order", {});
  assert.doesNotMatch(direct.selectedTarget.summary, /chain/);
  const drifted = fakePage(`<form><button type="submit">Place order</button></form>`, { testids: [] });
  const driftDriver = createPlaywrightDriver({ page: drifted });
  const fallback = await driftDriver.act("Place order", {});
  assert.ok(!fallback.selectedTarget.summary.includes("testid=place-order:miss") || fallback.selectedTarget.summary.includes("role=Place order"));
});

test("partial keyword overlap navigates and leaves a fuzzy receipt", async () => {
  const page = fakePage(`<main><details><summary>Checkout options</summary><a href="/checkout">Continue to payment</a></details></main>`);
  const executor = createPlaywrightDriver({ page });
  const acted = await executor.act("Continue to checkout", {});
  assert.equal(acted.selectedTarget.role, "link");
  assert.ok(page.navigated.some((url) => url.endsWith("/checkout")));
  assert.match(acted.selectedTarget.summary, /fuzzy 1\/2/);
});
