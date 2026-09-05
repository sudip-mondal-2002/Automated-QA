import { QaError } from "./errors.js";
import { assertStableId } from "./schema-validator.js";

const FILLER_PREFIX = /^(?:a|an|the|test(?: that)?|verify(?: that)?|ensure(?: that)?)\s+/i;

function cleanRequirement(requirement) {
  if (typeof requirement !== "string" || requirement.trim().length === 0) {
    throw new QaError("MISSING_REQUIREMENT", "A natural-language requirement is required");
  }
  return requirement.trim().replace(/[.!?]+$/, "");
}

function sentenceCase(value) {
  const cleaned = value.replace(FILLER_PREFIX, "").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "semantic-test";
}

export const SPEC_CHANNELS = Object.freeze(["web", "chat", "voice", "workflow", "api"]);

function inferredChannel(requirement, explicit) {
  if (explicit !== undefined) {
    if (!SPEC_CHANNELS.includes(explicit)) {
      throw new QaError("INVALID_CHANNEL", `Channel must be one of: ${SPEC_CHANNELS.join(", ")}`);
    }
    return explicit;
  }
  if (/chat|conversation|support agent|bot reply/i.test(requirement)) return "chat";
  if (/voice|call|spoken|utterance|ivr/i.test(requirement)) return "voice";
  if (/workflow|agent|pipeline|approval|automation/i.test(requirement)) return "workflow";
  if (/\bapi\b|endpoint|webhook|contract/i.test(requirement)) return "api";
  return "web";
}

function inferredExpectation(requirement) {
  if (/check\s*out|purchase|place(?:s)? (?:an )?order/i.test(requirement)) {
    return "Order confirmation is visible";
  }
  if (/log\s*in|sign\s*in/i.test(requirement)) return "Customer dashboard is visible";
  if (/register|sign\s*up|create(?:s)? (?:an )?account/i.test(requirement)) {
    return "Account confirmation is visible";
  }
  if (/search/i.test(requirement)) return "Relevant search results are visible";
  if (/add(?:s)? .+ (?:to|into) (?:the )?cart/i.test(requirement)) {
    return "The selected item is visible in the shopping cart";
  }
  if (/update|edit|change/i.test(requirement)) return "The saved changes are visible";
  return "The requested outcome is visible to the user";
}

export function draftSpec(requirement, options = {}) {
  const cleaned = cleanRequirement(requirement);
  const title = options.title?.trim() || sentenceCase(cleaned);
  const id = options.id || slugify(title);
  assertStableId(id);
  const channel = inferredChannel(cleaned, options.channel);

  const fixtures = options.beforeFixtures?.length
    ? { before: [...new Set(options.beforeFixtures)] }
    : undefined;

  const spec = {
    version: 1,
    id,
    title,
    environment: options.environment || "local",
    ...(fixtures ? { fixtures } : {}),
    steps: [
      {
        intent: options.intent?.trim() || sentenceCase(cleaned),
        ...(channel !== "web" ? { channel } : {}),
        expect: options.expectations?.length
          ? options.expectations.map((expectation) => expectation.trim())
          : [inferredExpectation(cleaned)],
      },
    ],
  };

  return spec;
}
