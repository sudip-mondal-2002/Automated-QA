import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  createNativeDesktopExecutor,
  createNativeWebExecutor,
  detectNativeCapability,
  draftSpec,
  formatQaError,
  NativeExecutor,
  parseJson,
  parseYaml,
  prepareEnvironment,
  QaError,
  redactSensitive,
  resolveReference,
  resolveReferences,
  slugify,
  spawnApplication,
  stringifyJson,
  stringifyYaml,
  validateDocument,
} from "../src/index.js";
import { issue } from "../src/errors.js";

test("document helpers accept parsed values, format output, and report conversion failures", () => {
  const value = { version: 1, id: "already-parsed" };
  assert.equal(parseYaml(value), value);
  assert.equal(parseJson(value), value);
  assert.match(stringifyYaml(value), /id: already-parsed/);
  assert.equal(stringifyJson(value), '{\n  "version": 1,\n  "id": "already-parsed"\n}\n');

  const aliasHeavyYaml = `root: &root [1]\nitems: [${Array.from({ length: 101 }, () => "*root").join(", ")}]`;
  assert.throws(
    () => parseYaml(aliasHeavyYaml),
    (error) => error instanceof QaError && error.code === "INVALID_YAML",
  );
});

test("drafting covers semantic defaults, normalization, and explicit overrides", () => {
  const cases = [
    ["sign in", "Customer dashboard is visible"],
    ["register a customer", "Account confirmation is visible"],
    ["search for a card", "Relevant search results are visible"],
    ["add a card to the cart", "The selected item is visible in the shopping cart"],
    ["edit the address", "The saved changes are visible"],
    ["open the help page", "The requested outcome is visible to the user"],
  ];
  for (const [requirement, expectation] of cases) {
    assert.equal(draftSpec(`${requirement}.`).steps[0].expect[0], expectation);
  }

  const explicit = draftSpec("verify that checkout!", {
    title: "  Custom title  ",
    intent: "  Use custom intent  ",
    beforeFixtures: ["login-customer", "login-customer"],
  });
  assert.equal(explicit.title, "Custom title");
  assert.equal(explicit.steps[0].intent, "Use custom intent");
  assert.deepEqual(explicit.fixtures.before, ["login-customer"]);
  assert.equal(slugify("---"), "semantic-test");
  assert.equal(slugify(`${"word ".repeat(30)}tail`).length, 64);
});

test("schema and error helpers expose stable actionable diagnostics", () => {
  assert.throws(
    () => validateDocument("missing-contract", {}),
    (error) => error instanceof QaError && error.code === "UNKNOWN_CONTRACT",
  );
  assert.throws(
    () => validateDocument("spec", { version: 1, id: "valid-id", title: "Title", environment: "local", steps: [], extra: true }),
    (error) => error instanceof QaError
      && error.issues.some((entry) => entry.path === "$.extra")
      && error.issues.some((entry) => entry.path === "$.steps"),
  );

  assert.equal(formatQaError("boom"), "Unexpected error: boom");
  assert.equal(formatQaError(new Error("boom")), "Unexpected error: boom");
  assert.equal(formatQaError(new QaError("EMPTY", "Nothing else")), "Nothing else [EMPTY]");
  assert.equal(
    formatQaError(new QaError("BROKEN", "Broken", [{ path: "$.field", message: "is wrong" }])),
    "Broken [BROKEN]\n  - $.field: is wrong",
  );
  assert.deepEqual(issue("$.field", "is wrong"), { path: "$.field", message: "is wrong" });
  assert.throws(
    () => validateDocument("environments", {
      version: 1,
      environments: { "bad/key": { type: 7 } },
    }),
    (error) => error instanceof QaError && error.issues.some((entry) => entry.path.includes('["bad/key"]')),
  );
});

test("reference resolution rejects missing and unsafe output paths and redacts recursively", () => {
  assert.deepEqual(resolveReference("literal"), { value: "literal", sensitive: false });
  assert.deepEqual(resolveReference("${FLAG}", { variables: { FLAG: false } }), { value: false, sensitive: true });
  assert.throws(
    () => resolveReference("${MISSING}", { variables: {} }),
    (error) => error instanceof QaError && error.code === "MISSING_ENVIRONMENT_VARIABLE",
  );
  for (const reference of ["${outputs.order.missing}", "${outputs.constructor.value}"]) {
    assert.throws(
      () => resolveReference(reference, { outputs: { order: {} } }),
      (error) => error instanceof QaError && error.code === "MISSING_RUN_OUTPUT",
    );
  }

  const resolved = resolveReferences(["${TOKEN}", 2, null, { nested: "${outputs.value}" }], {
    variables: { TOKEN: "long-secret" },
    outputs: { value: 7 },
  });
  assert.deepEqual(resolved.value, ["long-secret", 2, null, { nested: 7 }]);
  assert.deepEqual(
    redactSensitive({ message: "long-secret and secret", intent: "long-secret", values: ["secret", Buffer.from("secret")] }, ["secret", "long-secret"]),
    { message: "[REDACTED] and [REDACTED]", intent: "long-secret", values: ["[REDACTED]", Buffer.from("secret")] },
  );
});

test("native executor capability detection and forwarding are explicit", async () => {
  assert.throws(
    () => new NativeExecutor("mobile", {}),
    (error) => error instanceof QaError && error.code === "INVALID_NATIVE_EXECUTOR",
  );
  assert.equal((await createNativeWebExecutor({}).availability()).available, false);
  assert.deepEqual(await createNativeWebExecutor({
    act() {}, observe() {}, screenshot() {}, isAvailable: () => false,
  }).availability(), { available: false, explanation: "Native web capability is unavailable" });
  assert.deepEqual(await createNativeWebExecutor({
    act() {}, observe() {}, screenshot() {}, isAvailable: () => ({ available: false, explanation: "Browser is signed out" }),
  }).availability(), { available: false, explanation: "Browser is signed out" });

  const calls = [];
  const executor = createNativeDesktopExecutor({
    act: (...args) => calls.push(["act", ...args]),
    observe: (...args) => calls.push(["observe", ...args]),
    screenshot: (...args) => calls.push(["screenshot", ...args]),
    connect: (...args) => calls.push(["connect", ...args]),
    consoleErrors: (...args) => calls.push(["console", ...args]),
    networkErrors: (...args) => calls.push(["network", ...args]),
    close: (...args) => calls.push(["close", ...args]),
    rediscover: (...args) => calls.push(["rediscover", ...args]),
    recover: (...args) => calls.push(["recover", ...args]),
    waitFor: (...args) => calls.push(["waitFor", ...args]),
    compareDesign: (...args) => calls.push(["compareDesign", ...args]),
  });
  assert.deepEqual((await executor.availability()).unsupported, []);
  await executor.connect("target", "context");
  await executor.act("intent", "context");
  await executor.observe("expectation", "context");
  await executor.screenshot("context");
  await executor.consoleErrors("context");
  await executor.networkErrors("context");
  await executor.close("context");
  assert.equal(executor.supports("rediscover"), true);
  assert.equal(executor.supports("missing"), false);
  await executor.rediscover("intent", "context");
  await executor.recover("intent", "target", "context");
  await executor.waitFor("expectation", "context");
  await executor.compareDesign("request", "context");
  assert.deepEqual(calls.map(([name]) => name), [
    "connect", "act", "observe", "screenshot", "console", "network", "close", "rediscover", "recover", "waitFor", "compareDesign",
  ]);

  let fallbackContext;
  const fallback = createNativeWebExecutor({
    act(_intent, context) { fallbackContext = context; },
    observe() {},
    screenshot() {},
  });
  await fallback.recover("intent", { summary: "Replacement" }, { runId: "run" });
  assert.deepEqual(fallbackContext.recovery.target, { summary: "Replacement" });
  assert.equal(await fallback.rediscover("intent", {}), undefined);
  assert.equal(await fallback.waitFor("expectation", {}), undefined);

  assert.match((await detectNativeCapability({ type: "desktop" })).explanation, /computer use/);
  assert.match((await detectNativeCapability({ type: "web" })).explanation, /Browser or Chrome/);
  assert.match((await detectNativeCapability({ type: "web" }, { kind: "desktop" })).explanation, /native web executor/);
  assert.match((await detectNativeCapability({ type: "web" }, { kind: "web" })).explanation, /capability detection/);
});

test("environment preparation handles every readiness boundary", async () => {
  assert.deepEqual(await prepareEnvironment({ type: "desktop", app: "QA Shop" }), {
    target: { type: "desktop", app: "QA Shop" },
    startedApplication: null,
  });
  for (const baseUrl of ["not-a-url", "ftp://example.test"]) {
    await assert.rejects(
      () => prepareEnvironment({ type: "web", baseUrl }),
      (error) => error instanceof QaError && error.code === "INVALID_ENVIRONMENT_TARGET",
    );
  }
  await assert.rejects(
    () => prepareEnvironment({ type: "web", baseUrl: "http://example.test" }, { fetchImpl: 42 }),
    (error) => error instanceof QaError && error.code === "ENVIRONMENT_UNREACHABLE",
  );
  assert.equal((await prepareEnvironment(
    { type: "web", baseUrl: "http://example.test" },
    { fetchImpl: async () => ({ status: 503 }) },
  )).target.baseUrl, "http://example.test/");
  await assert.rejects(
    () => prepareEnvironment(
      { type: "web", baseUrl: "http://example.test" },
      { fetchImpl: async () => { throw new Error("offline"); } },
    ),
    (error) => error instanceof QaError && error.code === "ENVIRONMENT_UNREACHABLE",
  );

  let stopped = 0;
  await assert.rejects(
    () => prepareEnvironment(
      { type: "web", baseUrl: "http://example.test", startCommand: "npm start" },
      {
        fetchImpl: async () => { throw new Error("offline"); },
        startApplication: async () => ({ stop: async () => { stopped += 1; } }),
        startupTimeoutMs: 1,
      },
    ),
    (error) => error instanceof QaError && error.code === "ENVIRONMENT_UNREACHABLE",
  );
  assert.equal(stopped, 1);
});

test("spawned applications can be stopped idempotently", async () => {
  const application = spawnApplication(`${process.execPath} -e \"setInterval(() => {}, 1000)\"`, process.cwd());
  assert(application.child.pid > 0);
  const kill = process.kill;
  try {
    process.kill = () => {
      const error = new Error("already stopped");
      error.code = "ESRCH";
      throw error;
    };
    await application.stop();
    process.kill = () => {
      const error = new Error("not permitted");
      error.code = "EPERM";
      throw error;
    };
    await assert.rejects(() => application.stop(), (error) => error.code === "EPERM");
  } finally {
    process.kill = kill;
  }
  await application.stop();
  await once(application.child, "exit");
  await application.stop();
});
