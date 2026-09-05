import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function computeUntestedRisk({ siteMap, plan, gaps } = {}) {
  const covered = new Set((plan?.flows ?? []).flatMap((flow) => flow.pages ?? []));
  const fromGaps = (gaps?.untestedRisks ?? []).map((risk) => ({ ...risk }));
  for (const page of siteMap?.pages ?? []) {
    if (!covered.has(page.path)) {
      if (!fromGaps.some((risk) => risk.area === page.path)) {
        fromGaps.push({ area: page.path, reason: "no flow covers this page", risk: "medium", impact: "unverified surface" });
      }
    }
  }
  return fromGaps;
}

export function diffPrd({ prd, plan } = {}) {
  const requirements = prd?.requirements ?? [];
  if (requirements.length === 0) return { coveragePct: 1, requirements: [] };
  const rows = requirements.map((req) => {
    const flowIds = (plan?.flows ?? []).filter((flow) => (flow.requirementIds ?? []).includes(req.id)).map((flow) => flow.id);
    return { id: req.id, text: req.text, status: flowIds.length > 0 ? "covered" : "uncovered", flowIds, note: flowIds.length > 0 ? "" : "no flow maps to this requirement" };
  });
  const covered = rows.filter((row) => row.status === "covered").length;
  return { coveragePct: Math.round((covered / rows.length) * 100) / 100, requirements: rows };
}

export function buildReport({ plan, gapsHistory = [], generation = {}, runs = [], heals = [], decisions = [], prd = { requirements: [] }, startedAt, finishedAt, orchestrationId = `orch_${Date.now()}`, target = "" } = {}) {
  const scenarios = (plan?.flows ?? []).map((flow) => {
    const run = runs.find((r) => r.flowId === flow.id || r.specId === flow.id) ?? {};
    const fallbackSpec = String(flow.id).replace(/^flow_/, "");
    return {
      id: flow.id,
      title: flow.title,
      category: flow.category,
      priority: flow.priority,
      status: run.status ?? "skipped",
      classification: run.classification ?? "environment",
      confidence: run.confidence ?? 0.5,
      durationMs: run.durationMs ?? 0,
      specFile: run.specFile ?? `generated/${fallbackSpec}.spec.js`,
      runId: run.runId,
      runClassification: run.runClassification,
      blockedReason: run.blockedReason,
      screenshots: run.screenshots ?? [],
      heals: run.heals ?? [],
    };
  });
  const counts = { total: scenarios.length, passed: 0, healed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const scenario of scenarios) {
    if (scenario.status === "passed") counts.passed += 1;
    else if (scenario.status === "healed") counts.healed += 1;
    else if (scenario.status === "failed") counts.failed += 1;
    else if (scenario.status === "blocked") counts.blocked += 1;
    else counts.skipped += 1;
  }
  const lastGaps = gapsHistory.at(-1) ?? { score: 1, gaps: [], untestedRisks: [] };
  const prdGap = diffPrd({ prd, plan });
  const verdict = counts.failed > 0 ? "defects_found" : counts.blocked > 0 || counts.skipped === counts.total && counts.total > 0 ? "incomplete" : "clean";
  const exitCode = counts.failed > 0 ? 10 : verdict === "incomplete" ? 11 : 0;
  const started = startedAt ?? plan?.generatedAt ?? new Date().toISOString();
  const finished = finishedAt ?? new Date().toISOString();
  return {
    version: 1,
    orchestrationId,
    target,
    startedAt: started,
    finishedAt: finished,
    durationMs: Date.parse(finished) - Date.parse(started),
    summary: {
      verdict,
      exitCode,
      scenarios: counts,
      coverage: { score: lastGaps.score ?? 1, attempts: gapsHistory.length || 1, blockingGaps: (lastGaps.gaps ?? []).filter((g) => g.severity === "blocking").length, advisoryGaps: (lastGaps.gaps ?? []).filter((g) => g.severity !== "blocking").length },
      generation: {
        specs: generation.specs ?? 0,
        validated: generation.validated ?? 0,
        unvalidated: generation.unvalidated ?? 0,
        strategies: generation.strategies ?? {},
        assertions: generation.assertions ?? { checked: 0, verified: 0, withPredicates: 0, total: 0 },
      },
      healing: { attempted: heals.length, succeeded: heals.filter((h) => h.promoted || h.succeeded).length, promoted: heals.filter((h) => h.promoted).length },
    },
    decisions,
    scenarios,
    gaps: lastGaps.gaps ?? [],
    untestedRisks: computeUntestedRisk({ siteMap: { pages: [] }, plan, gaps: lastGaps }),
    prdGap,
    artifacts: { plan: "test-plan.md", gaps: "gaps.json", trace: "trace.jsonl", specs: "generated/" },
  };
}

export function renderReportMarkdown(report) {
  const lines = [
    `# Test Quality Report — ${report.summary.verdict}`,
    "",
    `Target ${report.target} · ${report.summary.scenarios.total} scenarios · coverage ${report.summary.coverage.score} · exit ${report.summary.exitCode}`,
    "",
    `Assertions: ${report.summary.generation?.assertions?.withPredicates ?? 0}/${report.summary.generation?.assertions?.total ?? 0} expectations have a checkable predicate · ${report.summary.generation?.assertions?.verified ?? 0} verified against the live page`,
    "",
    "## What the agent decided",
  ];
  for (const decision of report.decisions ?? []) {
    lines.push(`- [${decision.stage}] ${decision.decision}: ${decision.reason}`);
  }
  lines.push("", "## Scenarios (defects first)");
  const ordered = [...(report.scenarios ?? [])].sort((a, b) => (a.status === "failed" ? -1 : 1));
  for (const scenario of ordered) {
    lines.push(`- [${scenario.status}/${scenario.classification}] ${scenario.title} (${scenario.id})`);
  }
  lines.push("", "## Healer actions");
  const heals = (report.scenarios ?? []).flatMap((s) => (s.heals ?? []).map((h) => ({ ...h, scenario: s.id })));
  if (heals.length === 0) lines.push("- none");
  for (const heal of heals) lines.push(`- ${heal.scenario}: ${heal.from ?? "?"} -> ${heal.to ?? "?"}`);
  lines.push("", "## Coverage gaps remaining");
  if ((report.gaps ?? []).length === 0) lines.push("- none");
  for (const gap of report.gaps ?? []) lines.push(`- [${gap.severity}] ${gap.ruleId} → ${gap.target}`);
  lines.push("", "## Untested flow risk");
  if ((report.untestedRisks ?? []).length === 0) lines.push("- none");
  for (const risk of report.untestedRisks ?? []) lines.push(`- ${risk.area}: ${risk.reason}`);
  lines.push("", "## PRD gap analysis");
  lines.push(`Coverage ${(report.prdGap?.coveragePct ?? 1) * 100}%`);
  for (const req of report.prdGap?.requirements ?? []) {
    if (req.status === "uncovered") lines.push(`- ${req.id} UNCOVERED: ${req.text}`);
  }
  lines.push("", "## Artifacts", "- test-plan.md, gaps.json, trace.jsonl, generated/");
  return `${lines.join("\n")}\n`;
}

export async function writeReport({ outDir, report }) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outDir, "report.md"), renderReportMarkdown(report));
  return { json: path.join(outDir, "report.json"), markdown: path.join(outDir, "report.md") };
}
