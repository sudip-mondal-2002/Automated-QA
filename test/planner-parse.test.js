import assert from "node:assert/strict";
import test from "node:test";
import { detectLoginForm, parseHtml, selectorCandidates, STRATEGY_ORDER } from "../src/planner.js";

test("parseHtml extracts title, headings, links, forms and signals", () => {
  const parsed = parseHtml(`<!doctype html><html><head><title>Shop</title></head><body>
<h1>Welcome</h1><h2>Deals</h2>
<a href="/cart">Cart</a><a href="mailto:a@b.c">Mail</a>
<form method="POST" action="/checkout"><input name="card" type="text" required><input name="qty" type="number"><button>Place order</button></form>
</body></html>`);
  assert.equal(parsed.title, "Shop");
  assert.deepEqual(parsed.headings.map((h) => h.text), ["Welcome", "Deals"]);
  assert.deepEqual(parsed.links, [{ href: "/cart", text: "Cart" }, { href: "mailto:a@b.c", text: "Mail" }]);
  assert.equal(parsed.forms.length, 1);
  assert.equal(parsed.forms[0].action, "/checkout");
  assert.equal(parsed.forms[0].inputs[0].required, true);
  assert.equal(parsed.signals.checkout, true);
  assert.equal(parsed.signals.payment, true);
  assert.equal(parsed.signals.numeric, true);
  assert.equal(parsed.signals.destructive, true);
});

test("parseHtml handles empty and tag-free documents", () => {
  assert.deepEqual(parseHtml("").links, []);
  assert.equal(parseHtml(null).title, "");
  assert.equal(parseHtml("<title>T</title>").forms.length, 0);
});

test("selectorCandidates orders testid, role, label, text before css", () => {
  const ordered = selectorCandidates({ testid: "place-order", role: "button", name: "Place order", label: "Order", text: "Place order", tag: "button", id: "cta" }).map((c) => c.strategy);
  assert.deepEqual(ordered, [...STRATEGY_ORDER]);
  const minimal = selectorCandidates({});
  assert.equal(minimal.length, 1);
  assert.equal(minimal[0].strategy, "css");
  const roleOnly = selectorCandidates({ role: "link" });
  assert.deepEqual(roleOnly[0].value, ["link"]);
});

test("detectLoginForm finds password forms only", () => {
  const login = { forms: [{ action: "/login", inputs: [{ name: "u", type: "text" }, { name: "p", type: "password" }] }] };
  const other = { forms: [{ action: "/search", inputs: [{ name: "q", type: "text" }] }] };
  assert.equal(detectLoginForm(login)?.action, "/login");
  assert.equal(detectLoginForm(other), null);
  assert.equal(detectLoginForm({}), null);
});
