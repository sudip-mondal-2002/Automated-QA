import { createNativeWebExecutor } from "../src/index.js";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function demoNativeExecutor(fetchImpl = globalThis.fetch) {
  let baseUrl;
  let html = "";

  async function navigate(path, options = {}) {
    let response = await fetchImpl(new URL(path, baseUrl), { redirect: "manual", ...options });
    if (new Set([301, 302, 303, 307, 308]).has(response.status)) {
      response = await fetchImpl(new URL(response.headers.get("location"), baseUrl));
    }
    html = await response.text();
    return response;
  }

  return createNativeWebExecutor({
    isAvailable: () => ({ available: true }),
    async connect(target) {
      baseUrl = target.baseUrl;
      await navigate("/");
    },
    async act(intent, context) {
      if (intent === "Open the login page") {
        await navigate("/login");
        return { selectedTarget: { summary: "Login page", role: "document", name: "Customer sign in" } };
      }
      if (intent === "Sign in with the supplied customer credentials") {
        await navigate("/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ username: context.inputs.username, password: context.inputs.password }),
        });
        return { selectedTarget: { summary: "Sign in button", role: "button", name: "Sign in" } };
      }
      if (intent === "Open the shopping cart") {
        await navigate("/cart");
        return { selectedTarget: { summary: "Shopping cart link", role: "link", name: "Cart" } };
      }
      if (intent === "Proceed to checkout") {
        if (!html.includes("Proceed to checkout")) {
          return {
            status: "failed",
            observation: "The previously used Proceed to checkout control is absent",
            selectedTarget: { summary: "Proceed to checkout link", role: "link", name: "Proceed to checkout" },
          };
        }
        await navigate("/checkout");
        return { selectedTarget: { summary: "Checkout link", role: "link", name: "Proceed to checkout" } };
      }
      if (intent === "Submit the approved test payment details" || intent === "Place the order with the saved test card") {
        await navigate("/checkout", { method: "POST" });
        return {
          selectedTarget: { summary: "Order submission", role: "button", name: "Place order" },
          outputs: { order: { id: "QA-1001" } },
        };
      }
      if (intent === "Open the order created during this run") {
        await navigate("/orders/current");
        return { selectedTarget: { summary: "Current order link", role: "link", name: "View test order" } };
      }
      if (intent === "Delete it if it exists") {
        if (html.includes("Delete test order")) await navigate("/orders/current/delete", { method: "POST" });
        return { selectedTarget: { summary: "Delete test order", role: "button", name: "Delete test order" } };
      }
      return { status: "failed", observation: `Unsupported deterministic intent: ${intent}` };
    },
    rediscover(intent) {
      if (intent === "Proceed to checkout" && html.includes("Continue to payment")) {
        return {
          status: "found",
          equivalent: true,
          target: {
            summary: "Continue to payment link inside the Checkout options menu",
            role: "link",
            name: "Continue to payment",
          },
          observation: "The checkout action moved into Checkout options and was renamed Continue to payment",
        };
      }
      return { status: "not_found", explanation: `No equivalent control was found for ${intent}` };
    },
    async recover(intent, target) {
      if (intent === "Proceed to checkout" && target?.name === "Continue to payment") {
        await navigate("/checkout");
        return { selectedTarget: target };
      }
      return { status: "failed", observation: `The replacement target cannot perform ${intent}` };
    },
    observe(expectation) {
      const checks = {
        "Customer dashboard is visible": html.includes("Customer dashboard"),
        "Cart contains one item": html.includes("Cart contains one item"),
        "Checkout form is visible": html.includes("Checkout form"),
        "Order confirmation is visible": html.includes("Order confirmation"),
        "No error message is shown": !html.includes("An error message is shown"),
        "The test order is absent": html.includes("Test order absent"),
      };
      const passed = checks[expectation] === true;
      return { status: passed ? "passed" : "failed", observation: passed ? expectation : `${expectation} was not observed` };
    },
    compareDesign() {
      if (html.includes("data-design-regression")) {
        return {
          status: "regression",
          explanation: "The confirmation action appears before the heading, and the approved success treatment changed to a red warning panel.",
          findings: [
            {
              category: "order",
              status: "regression",
              explanation: "The primary action moved ahead of the confirmation heading and message.",
            },
            {
              category: "style",
              status: "regression",
              explanation: "The approved green success treatment changed to a prominent red bordered panel.",
            },
          ],
        };
      }
      return {
        status: "matched",
        explanation: "Required confirmation content, order, grouping, and success styling match the explicit reference.",
        findings: [
          {
            category: "components",
            status: "matched",
            explanation: "The heading, success message, and order link are present.",
          },
          {
            category: "layout",
            status: "matched",
            explanation: "The confirmation content keeps the approved hierarchy and grouping.",
          },
          {
            category: "style",
            status: "matched",
            explanation: "The success message retains the approved green treatment.",
          },
        ],
      };
    },
    screenshot() {
      return { data: PIXEL_PNG, extension: "png" };
    },
    consoleErrors: () => [],
    networkErrors: () => [],
  });
}
