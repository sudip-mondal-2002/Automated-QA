import assert from "node:assert/strict";
import test from "node:test";
import {
  createDemoApplication,
  DEMO_SCENARIOS,
  resetDemoState,
} from "../demo-app/server.js";
import { resetRunningDemo } from "../demo-app/reset.js";

async function signIn(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "customer", password: "password" }),
  });
  assert.equal(response.status, 200);
}

test("demo state reset maps the four judge-facing scenarios deterministically", () => {
  assert.deepEqual(DEMO_SCENARIOS, {
    pass: "stable",
    drift: "drift",
    functional: "broken",
    design: "design",
    locator: "locator-drift",
  });
  const state = { loggedIn: true, orderCreated: true, chatAnswered: true, variant: "drift-broken" };
  for (const [scenario, variant] of Object.entries(DEMO_SCENARIOS)) {
    assert.deepEqual(resetDemoState(state, scenario), { scenario, variant });
    assert.deepEqual(state, { loggedIn: false, orderCreated: false, chatAnswered: false, variant });
    state.loggedIn = true;
    state.orderCreated = true;
    state.chatAnswered = true;
  }
  assert.throws(() => resetDemoState(state, "unknown"), /Unknown demo scenario/);
});

test("a running demo can reset pass, drift, functional, and design states without restarting", async (t) => {
  const app = createDemoApplication();
  const baseUrl = await app.start(0);
  t.after(() => app.stop());

  const reference = await fetch(`${baseUrl}/reference/approved-confirmation`);
  assert.equal(reference.status, 200);
  assert.match(await reference.text(), /Approved checkout design reference/);

  for (const scenario of Object.keys(DEMO_SCENARIOS)) {
    const reset = await resetRunningDemo({ scenario, baseUrl });
    assert.equal(reset.scenario, scenario);
    assert.equal(reset.variant, DEMO_SCENARIOS[scenario]);
    assert.equal(app.state.loggedIn, false);
    assert.equal(app.state.orderCreated, false);
    await signIn(baseUrl);

    if (scenario === "drift") {
      assert.match(await (await fetch(`${baseUrl}/cart`)).text(), /Continue to payment/);
    } else {
      assert.match(await (await fetch(`${baseUrl}/cart`)).text(), /Proceed to checkout/);
    }
    await fetch(`${baseUrl}/checkout`, { method: "POST" });
    const confirmation = await (await fetch(`${baseUrl}/confirmation`)).text();
    if (scenario === "functional") assert.match(confirmation, /Order could not be completed/);
    else assert.match(confirmation, /Order confirmation/);
    if (scenario === "design") assert.match(confirmation, /data-design-regression/);
    else assert.doesNotMatch(confirmation, /data-design-regression/);
  }

  const invalid = await fetch(`${baseUrl}/__demo/reset`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ scenario: "unknown" }),
  });
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).error, /Unknown demo scenario/);
});

test("demo reset refuses unknown scenarios, remote targets, and failed reset responses", async () => {
  await assert.rejects(() => resetRunningDemo({ scenario: "unknown" }), /Scenario must be one of/);
  await assert.rejects(
    () => resetRunningDemo({ scenario: "pass", baseUrl: "https://127.0.0.1:3000" }),
    /must use HTTP on localhost/,
  );
  await assert.rejects(
    () => resetRunningDemo({ scenario: "pass", baseUrl: "http://example.com" }),
    /must use HTTP on localhost/,
  );
  await assert.rejects(
    () => resetRunningDemo({
      scenario: "pass",
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    }),
    /HTTP 503/,
  );
});
