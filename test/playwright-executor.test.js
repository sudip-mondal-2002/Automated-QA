import assert from "node:assert/strict";
import test from "node:test";
import { createPlaywrightDriver } from "../src/playwright-executor.js";
import { QaError } from "../src/index.js";

function fakePage(html, { clickFails = false } = {}) {
  const locator = {
    first: () => locator,
    nth: () => locator,
    count: async () => 0,
    click: async () => {
      if (clickFails) throw new Error("click timeout");
    },
    fill: async () => {},
    waitFor: async () => {},
  };
  return {
    navigated: [],
    filled: [],
    async goto(url) {
      this.navigated.push(url);
    },
    url: () => "http://127.0.0.1:4555/cart",
    async content() {
      return html;
    },
    getByRole: () => locator,
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
