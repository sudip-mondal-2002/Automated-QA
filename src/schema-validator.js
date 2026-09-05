import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { QaError } from "./errors.js";

const SCHEMA_FILES = {
  environments: "environments.schema.json",
  fixture: "fixture.schema.json",
  spec: "spec.schema.json",
  result: "result.schema.json",
  lastTest: "last-test.schema.json",
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map();

for (const [kind, fileName] of Object.entries(SCHEMA_FILES)) {
  const schemaUrl = new URL(`../schemas/${fileName}`, import.meta.url);
  const schema = JSON.parse(readFileSync(fileURLToPath(schemaUrl), "utf8"));
  validators.set(kind, ajv.compile(schema));
}

function propertyPath(instancePath) {
  if (!instancePath) return "$";
  const segments = instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

  return segments.reduce((path, segment) => {
    if (/^[0-9]+$/.test(segment)) return `${path}[${segment}]`;
    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment)) return `${path}.${segment}`;
    return `${path}[${JSON.stringify(segment)}]`;
  }, "$");
}

function errorPath(error) {
  const base = propertyPath(error.instancePath);
  if (error.keyword === "required") return `${base}.${error.params.missingProperty}`;
  if (error.keyword === "additionalProperties") return `${base}.${error.params.additionalProperty}`;
  return base;
}

function schemaIssues(errors = []) {
  const issues = errors.map((error) => ({
    path: errorPath(error),
    message: error.message ?? "is invalid",
  }));

  // oneOf errors include a useful branch error plus a generic final error.
  return issues.filter(
    (candidate, index) =>
      !(candidate.message === "must match exactly one schema in oneOf" && issues.length > 1 && index === issues.length - 1),
  );
}

export function validateDocument(kind, value) {
  const validator = validators.get(kind);
  if (!validator) throw new QaError("UNKNOWN_CONTRACT", `Unknown document contract: ${kind}`);

  if (!validator(value)) {
    throw new QaError(
      "VALIDATION_FAILED",
      `${kind} document is invalid`,
      schemaIssues(validator.errors),
    );
  }
  return value;
}

export function isStableId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}

export function assertStableId(value, path = "$.id") {
  if (!isStableId(value)) {
    throw new QaError("INVALID_ID", "ID is invalid", [
      { path, message: "use lowercase words separated by single hyphens" },
    ]);
  }
  return value;
}
