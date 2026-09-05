import assert from "node:assert/strict";
import test from "node:test";
import {
  createDemoApplication,
  DEMO_SCENARIO_DETAILS,
  DEMO_SCENARIOS,
  resetDemoState,
} from "../demo-app/server.js";
import { renderScenarioList, resetRunningDemo } from "../demo-app/reset.js";

async function signIn(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "customer", password: "password" }),
  });
  assert.equal(response.status, 200);
  return response.text();
}

test("demo state reset maps every headline and corner-case scenario deterministically", () => {
  assert.deepEqual(DEMO_SCENARIOS, {
    pass: "stable",
    drift: "drift",
    "missing-target": "missing-target",
    functional: "broken",
    fixture: "fixture-postcondition",
    "drift-functional": "drift-broken",
    design: "design",
    cleanup: "cleanup-broken",
    locator: "locator-drift",
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(DEMO_SCENARIO_DETAILS).map(([scenario, details]) => [scenario, details.variant])),
    DEMO_SCENARIOS,
  );
  assert.match(renderScenarioList(), /missing-target\s+H2\s+functional_regression/);
  assert.match(renderScenarioList(), /cleanup\s+E5\s+passed \+ cleanup issue/);
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

test("a running demo can reset every app mutation without restarting", async (t) => {
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
    const signedInPage = await signIn(baseUrl);

    if (scenario === "fixture") {
      assert.match(signedInPage, /customer session could not be established/i);
      assert.equal(app.state.loggedIn, false);
      continue;
    }

    const cart = await (await fetch(`${baseUrl}/cart`)).text();
    if (scenario === "drift" || scenario === "drift-functional") {
      assert.match(cart, /Continue to payment/);
    } else if (scenario === "missing-target") {
      assert.match(cart, /No equivalent checkout action is present/);
      assert.doesNotMatch(cart, /href="\/checkout"/);
      continue;
    } else {
      assert.match(cart, /Proceed to checkout/);
    }
    await fetch(`${baseUrl}/checkout`, { method: "POST" });
    const confirmation = await (await fetch(`${baseUrl}/confirmation`)).text();
    if (scenario === "functional" || scenario === "drift-functional") {
      assert.match(confirmation, /Order could not be completed/);
    }
    else assert.match(confirmation, /Order confirmation/);
    if (scenario === "design") assert.match(confirmation, /data-design-regression/);
    else assert.doesNotMatch(confirmation, /data-design-regression/);

    if (scenario === "cleanup") {
      const deletion = await fetch(`${baseUrl}/orders/current/delete`, { method: "POST" });
      assert.equal(deletion.status, 503);
      assert.match(await deletion.text(), /test order could not be removed/i);
      assert.equal(app.state.orderCreated, true);
    }
  }

  const spaShell = await (await fetch(`${baseUrl}/spa-shell`)).text();
  assert.match(spaShell, /<div id="root"><\/div>/);
  assert.doesNotMatch(spaShell, /<h1>/);

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
