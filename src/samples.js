export const SAMPLE_ENVIRONMENTS = {
  version: 1,
  environments: {
    local: {
      type: "web",
      baseUrl: "http://localhost:3000",
      startCommand: "npm run dev",
    },
    staging: {
      type: "web",
      baseUrl: "${QA_STAGING_URL}",
    },
    desktop: {
      type: "desktop",
      app: "${QA_DESKTOP_APP}",
    },
  },
};

export const SAMPLE_FIXTURES = [
  {
    version: 1,
    id: "login-customer",
    title: "Log in as a customer",
    inputs: {
      username: "${QA_CUSTOMER_USERNAME}",
      password: "${QA_CUSTOMER_PASSWORD}",
    },
    steps: [
      { intent: "Open the login page" },
      { intent: "Sign in with the supplied customer credentials" },
    ],
    expect: ["Customer dashboard is visible"],
  },
  {
    version: 1,
    id: "cleanup-test-order",
    title: "Remove the order created by this test",
    steps: [
      { intent: "Open the order created during this run" },
      { intent: "Delete it if it exists" },
    ],
    expect: ["The test order is absent"],
    idempotent: true,
  },
];

export const SAMPLE_SPECS = [
  {
    version: 1,
    id: "checkout-card",
    title: "Customer completes checkout",
    environment: "local",
    fixtures: {
      before: ["login-customer"],
      after: ["cleanup-test-order"],
    },
    steps: [
      {
        intent: "Open the shopping cart",
        expect: ["Cart contains one item"],
      },
      {
        intent: "Proceed to checkout",
        expect: ["Checkout form is visible"],
      },
      {
        intent: "Submit the approved test payment details",
        expect: ["Order confirmation is visible", "No error message is shown"],
      },
    ],
  },
  {
    version: 1,
    id: "checkout-saved-card",
    title: "Customer checks out with a saved card",
    environment: "local",
    fixtures: {
      before: ["login-customer"],
      after: ["cleanup-test-order"],
    },
    steps: [
      {
        intent: "Open the shopping cart",
        expect: ["Cart contains one item"],
      },
      {
        intent: "Proceed to checkout",
        expect: ["Checkout form is visible"],
      },
      {
        intent: "Place the order with the saved test card",
        expect: ["Order confirmation is visible", "No error message is shown"],
      },
    ],
  },
  {
    version: 1,
    id: "checkout-design",
    title: "Checkout matches the approved confirmation design",
    environment: "local",
    fixtures: {
      before: ["login-customer"],
      after: ["cleanup-test-order"],
    },
    design: {
      reference: "http://localhost:3000/reference/approved-confirmation",
      afterStep: 3,
      viewport: { width: 1280, height: 900 },
    },
    steps: [
      {
        intent: "Open the shopping cart",
        expect: ["Cart contains one item"],
      },
      {
        intent: "Proceed to checkout",
        expect: ["Checkout form is visible"],
      },
      {
        intent: "Submit the approved test payment details",
        expect: ["Order confirmation is visible", "No error message is shown"],
      },
    ],
  },
];

export const SAMPLE_SPEC = SAMPLE_SPECS[0];
