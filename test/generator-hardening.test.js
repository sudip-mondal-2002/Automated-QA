import test from "node:test";
import assert from "node:assert/strict";
import {
  authDetailsFrom,
  bindLocators,
  expectationPredicate,
  expectationProse,
  inputCandidates,
  mergeActionSteps,
  planToSpecs,
  predicateToPlaywright,
  renderAuthHelper,
  renderPlaywrightSpec,
  validateSelectors,
} from "../src/generator.js";

const siteMap = {
  origin: "http://127.0.0.1:1",
  pages: [
    {
      path: "/login",
      forms: [{
        action: "/login",
        method: "post",
        buttons: ["Sign in"],
        inputs: [
          { name: "username", type: "text", required: true, placeholder: "Email" },
          { name: "password", type: "password", required: true },
        ],
      }],
    },
    {
      path: "/checkout",
      forms: [{
        action: "/checkout",
        method: "post",
        buttons: ["Place order"],
        inputs: [{ name: "card", type: "text", required: true }],
      }],
    },
  ],
};

function planWith(steps, preconditions = []) {
  return {
    flows: [{
      id: "flow_checkout",
      title: "Place order",
      category: "happy",
      pages: ["/checkout"],
      preconditions,
      steps,
    }],
  };
}

test("predicates compile to real assertions and prose alone compiles to none", () => {
  assert.match(predicateToPlaywright({ kind: "text", value: "Order confirmation" }), /getByText\(\/Order confirmation\/i\)/);
  assert.match(predicateToPlaywright({ kind: "absent_text", value: "Error" }), /toHaveCount\(0\)/);
  assert.match(predicateToPlaywright({ kind: "url_contains", value: "/confirmation" }), /toHaveURL/);
  assert.match(predicateToPlaywright({ kind: "visible", selector: "#total" }), /locator\('#total'\)/);
  assert.match(predicateToPlaywright({ kind: "absent", selector: ".err" }), /toHaveCount\(0\)/);
  assert.match(predicateToPlaywright({ kind: "count", selector: "li", count: 3 }), /toHaveCount\(3\)/);

  // Anything that cannot be evaluated compiles to nothing rather than to a
  // guess that would silently pass or silently fail.
  assert.equal(predicateToPlaywright({ kind: "text" }), null);
  assert.equal(predicateToPlaywright({ kind: "count", selector: "li" }), null);
  assert.equal(predicateToPlaywright({ kind: "invented" }), null);
  assert.equal(predicateToPlaywright(null), null);

  assert.equal(expectationProse("plain"), "plain");
  assert.equal(expectationPredicate("plain"), null);
  assert.equal(expectationProse({ prose: "p" }), "p");
  assert.deepEqual(expectationPredicate({ prose: "p", assert: { kind: "text" } }), { kind: "text" });
});

test("an expectation with no predicate never becomes a self-asserting test", () => {
  // The old bug: `expect(page.getByText(/The submitted outcome is visible/i))`.
  // No application renders its own acceptance criteria, so that assertion could
  // never pass. Absent a predicate the generator must say so, not invent one.
  const plan = planWith([{ intent: "Place order", page: "/checkout", action: "submit", expect: ["The submitted outcome is visible"] }]);
  const [spec] = planToSpecs({ plan });
  const sidecar = bindLocators({ spec, flow: plan.flows[0], siteMap });
  const code = renderPlaywrightSpec({ spec, flow: plan.flows[0], sidecar, origin: siteMap.origin });

  assert.match(code, /UNVERIFIED expectation \(no predicate from the planner\): The submitted outcome is visible/);
  assert.doesNotMatch(code, /expect\(page\.getByText\(\/The submitted outcome/);
});

test("assertion validation refutes text and paths the application does not have", async () => {
  const plan = planWith([{
    intent: "Place order",
    page: "/checkout",
    action: "submit",
    expect: [
      { prose: "Confirmation shows", assert: { kind: "text", value: "Order confirmation" } },
      { prose: "Invented copy", assert: { kind: "text", value: "Thank you for your order" } },
      { prose: "Lands on confirmation", assert: { kind: "url_contains", value: "/order-confirmation" } },
    ],
  }]);
  const [spec] = planToSpecs({ plan });
  const sidecar = bindLocators({ spec, flow: plan.flows[0], siteMap });
  const validation = await validateSelectors({
    sidecar,
    origin: siteMap.origin,
    knownPaths: new Set(["/checkout", "/confirmation"]),
    fetchImpl: async () => ({ text: async () => "<h1>Order confirmation</h1><button>Place order</button>" }),
  });

  const [checked] = validation.bindings;
  assert.equal(checked.expectations[0].validated, true, "text actually on the page verifies");
  assert.equal(checked.expectations[1].validated, false, "copy the planner invented is refuted");
  assert.equal(checked.expectations[2].validated, false, "a path the crawl never saw is refuted");
  assert.equal(validation.stats.assertionsRefuted, 2);
  assert.equal(validation.validated, false, "a refuted assertion cannot leave the sidecar validated");
});

test("an unreachable target is never reported as validated", async () => {
  const plan = planWith([{ intent: "Place order", page: "/checkout", action: "submit", expect: [{ prose: "x", assert: { kind: "text", value: "y" } }] }]);
  const [spec] = planToSpecs({ plan });
  const sidecar = bindLocators({ spec, flow: plan.flows[0], siteMap });
  const validation = await validateSelectors({
    sidecar,
    origin: siteMap.origin,
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  assert.equal(validation.validated, false);
});

test("generated code fills inputs, signs in when required, and does not click a navigate step", () => {
  const plan = planWith(
    [
      { intent: "Open the checkout page", page: "/checkout", action: "navigate", expect: [{ prose: "Form shows", assert: { kind: "text", value: "Checkout form" } }] },
      { intent: "Place order", page: "/checkout", action: "submit", inputs: [{ name: "card", value: "4111", sensitive: false }], expect: [{ prose: "Done", assert: { kind: "text", value: "Order confirmation" } }] },
    ],
    ["authenticated"],
  );
  const [spec] = planToSpecs({ plan });
  const sidecar = bindLocators({ spec, flow: plan.flows[0], siteMap });
  const code = renderPlaywrightSpec({
    spec: { ...spec, _preconditions: spec._preconditions },
    flow: plan.flows[0],
    sidecar,
    origin: siteMap.origin,
  });

  assert.match(code, /import \{ signIn \} from '\.\/_auth\.js'/);
  assert.match(code, /await signIn\(page, BASE\)/);
  assert.match(code, /\.fill\('4111'\)/);
  // A navigate step is satisfied by the goto; clicking anyway submitted the
  // form a step early.
  assert.equal(code.match(/\.click\(\)/g).length, 1);
  assert.match(code, /getByText\(\/Order confirmation\/i\)/);
});

test("the sign-in helper is built from the crawled login form, not a guess", () => {
  const details = authDetailsFrom(siteMap);
  assert.deepEqual(details, {
    loginPath: "/login",
    userField: "username",
    passwordField: "password",
    submitLabel: "Sign in",
  });
  const helper = renderAuthHelper(details);
  assert.match(helper, /\[name="username"\]/);
  assert.match(helper, /\[name="password"\]/);
  assert.match(helper, /name: 'Sign in'/);
  // An application with no password field has no login form to derive.
  assert.equal(authDetailsFrom({ pages: [{ path: "/", forms: [] }] }), null);

  // A declared placeholder is the strongest label signal available.
  const candidates = inputCandidates({ name: "username" }, siteMap.pages[0].forms[0]);
  assert.equal(candidates[0].value, "Email");
});

test("action-only steps merge into the step that asserts their outcome", () => {
  // A planner will emit "fill the card field" with no expectation. That is
  // honest — filling a field is observable by nothing — but the spec contract
  // requires every step to declare what you should see.
  const merged = mergeActionSteps([
    { intent: "Fill the card", page: "/checkout", action: "fill", inputs: [{ name: "card", value: "4111" }], expect: [] },
    { intent: "Place order", page: "/checkout", action: "submit", expect: [{ prose: "Done" }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].intent, "Place order");
  assert.deepEqual(merged[0].inputs.map((input) => input.name), ["card"]);

  // A pending step on another page represents a navigation that still has to
  // happen, so it is kept and made assertable rather than dropped.
  const crossPage = mergeActionSteps([
    { intent: "Open cart", page: "/cart", action: "navigate", expect: [] },
    { intent: "Place order", page: "/checkout", action: "submit", expect: [{ prose: "Done" }] },
  ]);
  assert.equal(crossPage.length, 2);
  assert.match(crossPage[0].expect[0].prose, /Action completes: Open cart/);

  // A trailing action step has nothing to merge into.
  const trailing = mergeActionSteps([{ intent: "Click away", action: "click", expect: [] }]);
  assert.equal(trailing.length, 1);
  assert.match(trailing[0].expect[0].prose, /Action completes/);
});
