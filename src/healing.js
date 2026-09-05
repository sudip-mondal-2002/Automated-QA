import { QaError } from "./errors.js";

const FAILURE_STAGES = new Set(["action", "expectation"]);
const FAILURE_STATUSES = new Set(["failed", "blocked"]);
const REDISCOVERY_STATUSES = new Set(["found", "not_found", "ambiguous", "blocked"]);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "blocked"]);

function assertChoice(value, choices, name) {
  if (!choices.has(value)) {
    throw new QaError("INVALID_HEALING_INPUT", `${name} is invalid`);
  }
}

export function normalizeTarget(value) {
  if (!value || typeof value !== "object") return undefined;
  const role = value.role ? String(value.role) : undefined;
  const name = value.name ? String(value.name) : undefined;
  const summary = value.summary ? String(value.summary) : [role, name].filter(Boolean).join(" ");
  if (!summary) return undefined;
  return {
    summary,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
  };
}

export function normalizeRediscovery(response) {
  if (!response || typeof response !== "object") {
    return { status: "ambiguous", explanation: "Native rediscovery did not return a decision" };
  }
  const target = normalizeTarget(response.target ?? response.selectedTarget);
  const status = response.status ?? (target ? "found" : "ambiguous");
  if (!REDISCOVERY_STATUSES.has(status)) {
    return { status: "ambiguous", explanation: "Native rediscovery returned an invalid status" };
  }
  if (status === "found" && (!target || response.equivalent !== true)) {
    return {
      status: "ambiguous",
      explanation: target
        ? "The replacement was not explicitly confirmed as equivalent"
        : "Rediscovery did not identify an accessible replacement target",
    };
  }
  return {
    status,
    ...(target ? { target } : {}),
    ...(response.equivalent === true ? { equivalent: true } : {}),
    ...(response.observation ? { observation: String(response.observation) } : {}),
    ...(response.explanation ? { explanation: String(response.explanation) } : {}),
  };
}

export function createExpectationGuard(expectations) {
  if (!Array.isArray(expectations) || expectations.some((expectation) => typeof expectation !== "string")) {
    throw new QaError("INVALID_HEALING_INPUT", "Healing expectations must be an array of strings");
  }
  const baseline = JSON.stringify(expectations);
  const preserved = Object.freeze([...expectations]);
  return {
    expectations: preserved,
    assertUnchanged(candidate = expectations) {
      if (JSON.stringify(candidate) !== baseline || JSON.stringify(preserved) !== baseline) {
        throw new QaError(
          "EXPECTATION_MUTATED",
          "Healing cannot continue because an original expectation changed",
          [{ path: "$.steps[].expect", message: "must remain byte-for-byte unchanged during healing" }],
        );
      }
      return true;
    },
  };
}

export function classifyFailure({
  failure,
  rediscovery,
  readinessAvailable = false,
  verification,
  recoveryAttempted = false,
  expectationsUnchanged = true,
} = {}) {
  if (!failure || typeof failure !== "object") {
    throw new QaError("INVALID_HEALING_INPUT", "A failure is required for classification");
  }
  assertChoice(failure.stage, FAILURE_STAGES, "Failure stage");
  assertChoice(failure.status, FAILURE_STATUSES, "Failure status");

  if (!expectationsUnchanged) {
    return {
      decision: "blocked",
      classification: "blocked",
      reason: "Original expectations changed during recovery",
    };
  }
  if (failure.status === "blocked") {
    return {
      decision: "blocked",
      classification: "blocked",
      reason: failure.explanation || "Execution was blocked before recovery",
    };
  }

  if (verification) {
    assertChoice(verification.status, VERIFICATION_STATUSES, "Verification status");
    if (verification.status === "passed") {
      if (!recoveryAttempted) {
        return {
          decision: "blocked",
          classification: "blocked",
          reason: "A passing verification cannot be healed without a recorded recovery attempt",
        };
      }
      return {
        decision: "healed",
        classification: "healed",
        reason: "The original expectations passed unchanged after recovery",
      };
    }
    if (verification.status === "blocked") {
      return {
        decision: "blocked",
        classification: "blocked",
        reason: verification.explanation || "Recovery verification was blocked",
      };
    }
    return {
      decision: "functional_regression",
      classification: "functional_regression",
      reason: verification.explanation || "The original expectations still fail after recovery",
    };
  }

  if (failure.stage === "expectation") {
    return readinessAvailable
      ? { decision: "wait_for_readiness", reason: "A failed observation may be caused by UI readiness" }
      : {
        decision: "functional_regression",
        classification: "functional_regression",
        reason: failure.explanation || "The expected user-visible outcome failed",
      };
  }

  if (rediscovery === undefined) {
    return { decision: "rediscover_target", reason: "The failed action may have harmless target drift" };
  }
  if (rediscovery?.status === "blocked") {
    return {
      decision: "blocked",
      classification: "blocked",
      reason: rediscovery.explanation || "Target rediscovery was blocked",
    };
  }
  if (rediscovery?.status === "found" && rediscovery.equivalent === true && rediscovery.target) {
    return { decision: "retry_equivalent_target", reason: "An explicitly equivalent target was found" };
  }
  return {
    decision: "functional_regression",
    classification: "functional_regression",
    reason: rediscovery?.explanation || failure.explanation || "No safe equivalent target was found",
  };
}
