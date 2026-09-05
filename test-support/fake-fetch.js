export function fakeFetch(routes = {}, options = {}) {
  const calls = [];
  const defaultStatus = options.defaultStatus ?? 404;
  const impl = async (target, init = {}) => {
    const url = new URL(String(target));
    calls.push({ url: url.href, path: url.pathname, method: (init.method ?? "GET").toUpperCase() });
    const route = routes[url.pathname] ?? routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (!route) {
      return {
        status: defaultStatus,
        ok: false,
        headers: { get: () => null },
        text: async () => "Not found",
      };
    }
    const resolved = typeof route === "function" ? await route(url, init) : route;
    const status = resolved.status ?? 200;
    const headers = {
      get: (name) => {
        const lower = String(name).toLowerCase();
        if (lower === "set-cookie") return resolved.cookie ?? resolved.headers?.["set-cookie"] ?? null;
        if (lower === "location") return resolved.location ?? null;
        return null;
      },
    };
    return {
      status,
      ok: status >= 200 && status < 300,
      headers,
      text: async () => resolved.html ?? resolved.text ?? "",
      json: async () => resolved.json ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

export const LOGIN_HTML = `<!doctype html><html><head><title>Sign in</title></head><body>
<h1>Customer sign in</h1>
<form method="post" action="/login">
<label>Email <input name="username" type="email" required></label>
<label>Password <input name="password" type="password" required></label>
<button type="submit">Sign in</button>
</form></body></html>`;

export const HOME_HTML = `<!doctype html><html><head><title>Home</title></head><body>
<h1>Welcome</h1><h2>Shop</h2>
<a href="/login">Sign in</a><a href="/cart">Cart</a>
<form method="post" action="/search"><input name="q" required><button>Search</button></form>
</body></html>`;

export const CART_HTML = `<!doctype html><html><head><title>Cart</title></head><body>
<h1>Shopping cart</h1>
<table><tr><td>Item</td></tr></table>
<input type="number" name="quantity">
<a href="/checkout">Proceed to checkout</a>
<form method="post" action="/checkout"><input name="card" required><button>Place order</button></form>
</body></html>`;
