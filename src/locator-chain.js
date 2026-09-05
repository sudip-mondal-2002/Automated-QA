export const STRATEGY_ORDER = Object.freeze(["testid", "role", "label", "text", "css"]);

const RANK = new Map(STRATEGY_ORDER.map((s, i) => [s, i]));

export function buildChain(candidates = []) {
  const seen = new Set();
  const ordered = [];
  for (const candidate of [...candidates].sort((a, b) => (RANK.get(a.strategy) ?? 99) - (RANK.get(b.strategy) ?? 99))) {
    const key = `${candidate.strategy}:${JSON.stringify(candidate.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

export async function resolveWithChain({ candidates = [], probe }) {
  const chain = buildChain(candidates);
  const attempts = [];
  for (const candidate of chain) {
    try {
      const ok = probe ? await probe(candidate) : true;
      attempts.push({ ...candidate, ok: Boolean(ok) });
      if (ok) return { resolved: candidate, attempts, strategy: candidate.strategy, value: candidate.value };
    } catch {
      attempts.push({ ...candidate, ok: false });
    }
  }
  return { resolved: null, attempts, strategy: null, value: null };
}

export function triage({ failure, chainResult, observation = "", priorAttempts = 0, httpStatus = 200, consoleErrors = [], networkErrors = [] } = {}) {
  const attempts = chainResult?.attempts ?? [];
  const resolved = chainResult?.resolved ?? null;
  if (failure?.code === "EXPECTATION_MUTATED" || /byte-for-byte|unchanged/i.test(String(failure?.message ?? failure ?? ""))) {
    return { classification: "app_defect", confidence: 1.0, evidence: "expectation guard tripped; assertions must never be healed" };
  }
  if (!resolved && attempts.length === 0) {
    return { classification: "environment", confidence: 0.6, evidence: observation || "no locator chain to probe" };
  }
  if (resolved && attempts.length > 1) {
    const from = attempts[0];
    return { classification: "broken_locator", confidence: 0.9, evidence: `primary ${from.strategy} failed, fallback ${resolved.strategy} resolved`, from, to: resolved };
  }
  if (!resolved) {
    if (httpStatus === 0 || failure?.code === "ENVIRONMENT_UNREACHABLE") {
      return { classification: "environment", confidence: 0.95, evidence: "target unreachable" };
    }
    if ([404, 500, 502, 503].includes(httpStatus) || httpStatus >= 500 || (consoleErrors?.length ?? 0) > 0 || (networkErrors?.length ?? 0) > 0) {
      return { classification: "app_defect", confidence: 0.85, evidence: `chain exhausted with HTTP ${httpStatus} or console/network errors` };
    }
    if (priorAttempts > 0) {
      return { classification: "flaky", confidence: 0.6, evidence: "exhausted after prior attempts" };
    }
    return { classification: "app_defect", confidence: 0.7, evidence: observation || "expected text absent from DOM" };
  }
  if (priorAttempts > 0 && attempts.length === 1) {
    return { classification: "flaky", confidence: 0.8, evidence: "passed on retry with identical locator" };
  }
  return { classification: "broken_locator", confidence: 0.7, evidence: "single-strategy resolution" };
}
