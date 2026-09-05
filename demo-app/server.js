#!/usr/bin/env node
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

function page(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · QA Shop</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f4f7fb; }
      body { margin: 0; }
      header { display: flex; justify-content: space-between; padding: 18px 28px; background: #172033; color: white; }
      header a { color: white; }
      main { width: min(720px, calc(100% - 40px)); margin: 48px auto; padding: 32px; background: white; border-radius: 18px; box-shadow: 0 16px 48px #1720331a; }
      nav { display: flex; gap: 16px; }
      label { display: grid; gap: 6px; margin: 16px 0; }
      input { padding: 12px; border: 1px solid #b9c3d3; border-radius: 8px; }
      button, .button { display: inline-block; padding: 12px 18px; border: 0; border-radius: 9px; background: #2563eb; color: white; text-decoration: none; cursor: pointer; }
      .quiet { color: #526175; }
      .item { display: flex; justify-content: space-between; padding: 18px 0; border-bottom: 1px solid #e3e8ef; }
      .success { padding: 18px; border-radius: 10px; background: #dcfce7; color: #166534; }
    </style>
  </head>
  <body>
    <header><strong>QA Shop</strong><nav><a href="/dashboard">Dashboard</a><a href="/cart">Cart</a></nav></header>
    <main>${body}</main>
  </body>
</html>`;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  response.end(body);
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

function redirect(response, location) {
  response.writeHead(303, { location });
  response.end();
}

async function form(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export const DEMO_SCENARIOS = Object.freeze({
  pass: "stable",
  drift: "drift",
  functional: "broken",
  design: "design",
  locator: "locator-drift",
});

const DEMO_VARIANTS = new Set(["stable", "drift", "broken", "drift-broken", "design", "locator-drift"]);

export function resetDemoState(state, scenario) {
  const variant = DEMO_SCENARIOS[scenario];
  if (!variant) throw new TypeError(`Unknown demo scenario: ${scenario}`);
  state.loggedIn = false;
  state.orderCreated = false;
  state.chatAnswered = false;
  state.variant = variant;
  return { scenario, variant };
}

export function createDemoApplication({ variant = "stable" } = {}) {
  if (!DEMO_VARIANTS.has(variant)) {
    throw new TypeError(`Unknown demo variant: ${variant}`);
  }
  const state = { loggedIn: false, orderCreated: false, chatAnswered: false, variant };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const hasCheckoutDrift = state.variant === "drift" || state.variant === "drift-broken";
    const hasBrokenConfirmation = state.variant === "broken" || state.variant === "drift-broken";
    const hasDesignRegression = state.variant === "design";

    if (request.method === "GET" && url.pathname === "/") return redirect(response, "/login");
    if (request.method === "GET" && url.pathname === "/reference/approved-confirmation") {
      return send(response, 200, page("Approved confirmation reference", `
        <p class="quiet">Approved checkout design reference</p>
        <h1>Order confirmation</h1>
        <p class="success">Order QA-1001 was placed successfully.</p>
        <a href="#approved-order-link">View test order</a>`));
    }
    if (request.method === "POST" && url.pathname === "/__demo/reset") {
      const values = await form(request);
      try {
        return sendJson(response, 200, resetDemoState(state, values.get("scenario")));
      } catch (error) {
        return sendJson(response, 422, { error: error.message, scenarios: Object.keys(DEMO_SCENARIOS) });
      }
    }
    if (request.method === "GET" && url.pathname === "/login") {
      return send(response, 200, page("Sign in", `
        <h1>Customer sign in</h1>
        <p class="quiet">Use the configured QA customer credentials.</p>
        <form method="post" action="/login">
          <label>Email <input name="username" autocomplete="username" required></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Sign in</button>
        </form>`));
    }
    if (request.method === "POST" && url.pathname === "/login") {
      const credentials = await form(request);
      if (!credentials.get("username") || !credentials.get("password")) {
        return send(response, 400, page("Sign in failed", "<h1>Sign in failed</h1><p>An error message is shown.</p>"));
      }
      state.loggedIn = true;
      return redirect(response, "/dashboard");
    }
    if (!state.loggedIn) return redirect(response, "/login");

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return send(response, 200, page("Dashboard", `
        <h1>Customer dashboard</h1>
        <p>Welcome back. Your saved card is ready for the deterministic QA checkout.</p>
        <a class="button" href="/cart">Open shopping cart</a>
        <a class="button" href="/chat">Open support chat</a>`));
    }
    if (request.method === "GET" && url.pathname === "/chat") {
      const asked = url.searchParams.get("asked") === "1" || state.chatAnswered === true;
      return send(response, 200, page("Support chat", `
        <h1>Support chat</h1>
        <p>Chat transcript is visible.</p>
        ${asked
          ? `<p class="success">Support response is visible: refunds are processed in 5 days.</p>`
          : `<form method="post" action="/chat"><button type="submit">Ask for the refund policy</button></form>`}`));
    }
    if (request.method === "POST" && url.pathname === "/chat") {
      state.chatAnswered = true;
      return redirect(response, "/chat?asked=1");
    }
    if (request.method === "GET" && url.pathname === "/cart") {
      const locatorDrift = state.variant === "locator-drift";
      return send(response, 200, page("Shopping cart", `
        <h1>Shopping cart</h1>
        <div class="item"><span>QA Demo Card</span><strong>₹499</strong></div>
        <p>Cart contains one item.</p>
        ${hasCheckoutDrift
          ? `<details><summary>Checkout options</summary><a class="button" href="/checkout">Continue to payment</a></details>`
          : locatorDrift
            ? `<a class="button" href="/checkout">Proceed to checkout</a>`
            : `<a class="button" data-testid="proceed-checkout" href="/checkout">Proceed to checkout</a>`}`));
    }
    if (request.method === "GET" && url.pathname === "/checkout") {
      const locatorDrift = state.variant === "locator-drift";
      return send(response, 200, page("Checkout", `
        <h1>Checkout form</h1>
        <p>Total: ₹499 · Saved test card ending in 4242</p>
        <form method="post" action="/checkout"><label>Card <input name="card" required></label><button type="submit" ${locatorDrift ? "" : `data-testid="place-order"`}>Place order</button></form>`));
    }
    if (request.method === "POST" && url.pathname === "/checkout") {
      const values = await form(request);
      if (!values.get("card") && request.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
        return send(response, 400, page("Checkout", `<h1>Checkout form</h1><p>A validation error names the card field.</p><p>No order is created.</p>`));
      }
      state.orderCreated = true;
      return redirect(response, "/confirmation");
    }
    if (request.method === "GET" && url.pathname === "/confirmation") {
      return send(response, 200, hasBrokenConfirmation
        ? page("Order failed", `
        <h1>Order could not be completed</h1>
        <p>An error message is shown.</p>`)
        : hasDesignRegression
          ? page("Order confirmed", `
        <section data-design-regression style="display:grid;gap:32px;background:#fef2f2;padding:28px;border:4px solid #dc2626">
          <a class="button" href="/orders/current" style="background:#dc2626">View test order</a>
          <p>Order QA-1001 was placed successfully.</p>
          <h1>Order confirmation</h1>
        </section>`)
        : page("Order confirmed", `
        <h1>Order confirmation</h1>
        <p class="success">Order QA-1001 was placed successfully.</p>
        <a href="/orders/current">View test order</a>`));
    }
    if (request.method === "GET" && url.pathname === "/orders/current") {
      return send(response, 200, page("Test order", state.orderCreated
        ? `<h1>Order QA-1001</h1><form method="post" action="/orders/current/delete"><button type="submit">Delete test order</button></form>`
        : `<h1>Test order absent</h1><p>There is no test order to remove.</p>`));
    }
    if (request.method === "GET" && url.pathname === "/orders/history") {
      return send(response, 200, page("Order history", `<h1>Order history</h1><p>An empty state is visible: no past orders.</p>`));
    }
    if (request.method === "POST" && url.pathname === "/orders/current/delete") {
      state.orderCreated = false;
      return redirect(response, "/orders/current");
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      state.loggedIn = false;
      state.orderCreated = false;
      state.chatAnswered = false;
      return redirect(response, "/login");
    }
    return send(response, 404, page("Not found", "<h1>Not found</h1>"));
  });

  return {
    state,
    server,
    async start(port = 3000, host = "127.0.0.1") {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return `http://${host}:${address.port}`;
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const portArgument = process.argv.indexOf("--port");
  const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : Number(process.env.PORT || 3000);
  const variantArgument = process.argv.indexOf("--variant");
  const variant = variantArgument >= 0 ? process.argv[variantArgument + 1] : "stable";
  const app = createDemoApplication({ variant });
  const url = await app.start(port);
  console.log(`QA demo application is ready at ${url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await app.stop();
      process.exit(0);
    });
  }
}
