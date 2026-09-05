import YAML from "yaml";
import { QaError } from "./errors.js";

function yamlErrorIssue(error, source) {
  let position = error.linePos?.[0];
  if (!position && Number.isInteger(error.pos?.[0])) {
    const prefix = source.slice(0, error.pos[0]);
    const lines = prefix.split(/\r?\n/);
    position = { line: lines.length, col: lines.at(-1).length + 1 };
  }
  const path = position ? `$ (line ${position.line}, column ${position.col})` : "$";
  return { path, message: error.message };
}

export function parseYaml(source, label = "YAML") {
  if (typeof source !== "string") return source;

  const document = YAML.parseDocument(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    throw new QaError(
      "INVALID_YAML",
      `${label} could not be parsed`,
      document.errors.map((error) => yamlErrorIssue(error, source)),
    );
  }

  try {
    return document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new QaError("INVALID_YAML", `${label} could not be parsed`, [
      { path: "$", message: error.message },
    ]);
  }
}

export function stringifyYaml(value) {
  return YAML.stringify(value, { lineWidth: 0 });
}

export function parseJson(source, label = "JSON") {
  if (typeof source !== "string") return source;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new QaError("INVALID_JSON", `${label} could not be parsed`, [
      { path: "$", message: error.message },
    ]);
  }
}

export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
