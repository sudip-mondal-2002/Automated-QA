import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { QaError } from "./errors.js";
import { resolveReference } from "./references.js";

export const DEFAULT_DESIGN_VIEWPORT = Object.freeze({ width: 1440, height: 1000 });

export const DESIGN_COMPARISON_RULES = Object.freeze([
  "Check that required components and visible content in the reference are present.",
  "Compare major layout, order, grouping, and alignment.",
  "Compare only obvious style signals such as component variant, dominant color, and large spacing differences.",
  "Ignore minor pixel, font-rendering, anti-aliasing, and sub-pixel differences.",
  "Report a regression only when the explicit reference directly supports a concrete finding.",
  "Never update or reinterpret the reference to make the rendered state pass.",
]);

const IMAGE_EXTENSIONS = new Map([
  [".png", "png"],
  [".jpg", "jpg"],
  [".jpeg", "jpeg"],
  [".webp", "webp"],
]);
const COMPARISON_STATUSES = new Set(["matched", "regression", "blocked"]);
const FINDING_STATUSES = new Set(["matched", "regression", "not_checked"]);
const FINDING_CATEGORIES = new Set([
  "components",
  "content",
  "layout",
  "order",
  "grouping",
  "alignment",
  "style",
]);

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function designError(code, message, path = "$.design.reference") {
  return new QaError(code, message, [{ path, message }]);
}

export function designConfigurationForSpec(design, stepCount) {
  return {
    reference: design.reference,
    viewport: design.viewport ?? DEFAULT_DESIGN_VIEWPORT,
    afterStep: design.afterStep ?? stepCount,
  };
}

export async function resolveDesignReference(reference, {
  repositoryRoot = process.cwd(),
  variables = process.env,
  outputs = {},
} = {}) {
  const resolved = resolveReference(reference, { variables, outputs });
  if (typeof resolved.value !== "string" || resolved.value.trim().length === 0) {
    throw designError("INVALID_DESIGN_REFERENCE", "Design reference must resolve to a non-empty string");
  }

  const source = resolved.value.trim();
  if (/^https?:\/\//i.test(source)) {
    let url;
    try {
      url = new URL(source);
    } catch {
      throw designError("INVALID_DESIGN_REFERENCE", "Design reference URL is invalid");
    }
    const hostname = url.hostname.toLowerCase();
    return {
      reference,
      source: url.href,
      kind: hostname === "figma.com" || hostname.endsWith(".figma.com") ? "figma" : "url",
      sensitiveValues: resolved.sensitive ? [source] : [],
    };
  }

  let requestedPath;
  try {
    requestedPath = source.startsWith("file:")
      ? fileURLToPath(source)
      : isAbsolute(source) ? source : resolve(repositoryRoot, source);
  } catch {
    throw designError("INVALID_DESIGN_REFERENCE", "Design reference file URL is invalid");
  }

  let realRoot;
  let realSource;
  try {
    [realRoot, realSource] = await Promise.all([realpath(repositoryRoot), realpath(requestedPath)]);
  } catch (error) {
    throw new QaError(
      "DESIGN_REFERENCE_NOT_FOUND",
      `Design reference could not be read: ${source}`,
      [{ path: "$.design.reference", message: "reference file does not exist or is not readable" }],
      { cause: error },
    );
  }
  if (!isInside(realRoot, realSource)) {
    throw designError("DESIGN_REFERENCE_OUTSIDE_REPOSITORY", "Design reference must stay inside the repository");
  }
  const extension = IMAGE_EXTENSIONS.get(extname(realSource).toLowerCase());
  if (!extension) {
    throw designError("UNSUPPORTED_DESIGN_REFERENCE", "Design reference must be a PNG, JPEG, or WebP image");
  }

  let contents;
  try {
    contents = await readFile(realSource);
  } catch (error) {
    throw new QaError(
      "DESIGN_REFERENCE_NOT_FOUND",
      `Design reference could not be read: ${source}`,
      [{ path: "$.design.reference", message: "reference file is not readable" }],
      { cause: error },
    );
  }
  return {
    reference,
    source: realSource,
    kind: "image",
    artifact: { contents, extension },
    sensitiveValues: resolved.sensitive ? [source] : [],
  };
}

export function buildDesignComparisonRequest({ reference, actual, viewport, afterStep }) {
  return {
    version: 1,
    reference: {
      kind: reference.kind,
      source: reference.source,
      ...(reference.artifact ? { image: reference.artifact } : {}),
    },
    actual,
    viewport: { ...viewport },
    checkpoint: { afterStep },
    rules: DESIGN_COMPARISON_RULES,
  };
}

export function normalizeDesignComparison(response) {
  if (!response || typeof response !== "object" || !COMPARISON_STATUSES.has(response.status)) {
    return {
      status: "blocked",
      explanation: "Native design comparison did not return a valid decision",
      findings: [],
    };
  }

  const findings = [];
  for (const finding of response.findings ?? []) {
    if (
      !finding
      || typeof finding !== "object"
      || !FINDING_CATEGORIES.has(finding.category)
      || !FINDING_STATUSES.has(finding.status)
      || typeof finding.explanation !== "string"
      || finding.explanation.trim().length === 0
    ) {
      return {
        status: "blocked",
        explanation: "Native design comparison returned an invalid finding",
        findings: [],
      };
    }
    findings.push({
      category: finding.category,
      status: finding.status,
      explanation: finding.explanation.trim(),
    });
  }

  if (response.status === "regression" && !findings.some((finding) => finding.status === "regression")) {
    return {
      status: "blocked",
      explanation: "A design regression requires at least one concrete reference-backed finding",
      findings,
    };
  }
  if (response.status === "matched" && findings.some((finding) => finding.status === "regression")) {
    return {
      status: "blocked",
      explanation: "Design comparison contradicted its own matched decision",
      findings,
    };
  }

  const fallback = response.status === "matched"
    ? "The rendered state matches the explicit design reference"
    : response.status === "regression"
      ? "The rendered state has a reference-backed design regression"
      : "Design comparison was blocked";
  return {
    status: response.status,
    explanation: typeof response.explanation === "string" && response.explanation.trim().length > 0
      ? response.explanation.trim()
      : fallback,
    findings,
    ...(response.referenceScreenshot ? { referenceScreenshot: response.referenceScreenshot } : {}),
  };
}
