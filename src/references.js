import { QaError } from "./errors.js";

const REFERENCE = /^\$\{([A-Z][A-Z0-9_]*|outputs\.[A-Za-z][A-Za-z0-9_.-]*)\}$/;
const UNSAFE_OUTPUT_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const IMMUTABLE_CONTRACT_FIELDS = new Set([
  "runId",
  "specId",
  "environment",
  "fixtureId",
  "phase",
  "type",
  "status",
  "intent",
  "expectation",
]);

function outputValue(outputs, reference) {
  const segments = reference.slice("outputs.".length).split(".");
  let value = outputs;
  for (const segment of segments) {
    if (UNSAFE_OUTPUT_SEGMENTS.has(segment) || value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      throw new QaError("MISSING_RUN_OUTPUT", `Run output ${reference} is unavailable`, [
        { path: `\${${reference}}`, message: "the referenced value was not produced by an earlier step" },
      ]);
    }
    value = value[segment];
  }
  return value;
}

export function resolveReference(reference, { variables = process.env, outputs = {} } = {}) {
  const match = typeof reference === "string" ? reference.match(REFERENCE) : null;
  if (!match) return { value: reference, sensitive: false };

  const name = match[1];
  if (name.startsWith("outputs.")) {
    return { value: outputValue(outputs, name), sensitive: true };
  }
  if (!Object.hasOwn(variables, name) || variables[name] === undefined) {
    throw new QaError("MISSING_ENVIRONMENT_VARIABLE", `Required environment variable ${name} is not set`, [
      { path: `\${${name}}`, message: "set the variable before running this test" },
    ]);
  }
  return { value: variables[name], sensitive: true };
}

export function resolveReferences(value, context = {}) {
  const sensitiveValues = new Set();

  function visit(candidate) {
    if (typeof candidate === "string") {
      const resolved = resolveReference(candidate, context);
      if (resolved.sensitive && ["string", "number", "boolean"].includes(typeof resolved.value)) {
        const text = String(resolved.value);
        if (text.length > 0) sensitiveValues.add(text);
      }
      return resolved.value;
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [key, visit(entry)]));
    }
    return candidate;
  }

  return { value: visit(value), sensitiveValues };
}

export function redactSensitive(value, sensitiveValues = []) {
  const secrets = [...sensitiveValues]
    .map(String)
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);

  function visit(candidate) {
    if (typeof candidate === "string") {
      return secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), candidate);
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate && typeof candidate === "object" && !Buffer.isBuffer(candidate)) {
      return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [
        key,
        IMMUTABLE_CONTRACT_FIELDS.has(key) ? entry : visit(entry),
      ]));
    }
    return candidate;
  }

  return visit(value);
}
