#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SCENARIO_DETAILS } from "../demo-app/server.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cornerCaseDocument = path.join(repositoryRoot, "docs", "corner-test-cases.md");
const LIVE_DEMO_TEST = "live corner demo exposes D1, H1, H2, H3, H4, H7, and E5 as deterministic states";

const evidence = (file, name) => ({ file, name });
const shared = {
  plannerFallback: evidence("test/subagents-corner.test.js", "P1/P2 corner: missing or throwing planner degrades to deterministic"),
  plannerRepair: evidence("test/subagents-corner.test.js", "P3/P4 corner: invalid draft gets one repair, empty plan rejected"),
  plannerHonesty: evidence("test/subagents-corner.test.js", "P5 corner: planner cannot smuggle selectors or invented predicates"),
  plannerBrief: evidence("test/subagents-corner.test.js", "P6/P7/P8 corner: brief marks anonymous, degraded, truncation"),
  plannerIdsAndTrace: evidence("test/subagents-corner.test.js", "P9/P10 corner: colliding ids dedupe, lifecycle traced"),
  healingEquivalence: evidence("test/subagents-corner.test.js", "H1/H2 corner: only explicit equivalence retries"),
  healingAbsent: evidence("test/subagents-corner.test.js", "H5/H6 corner: null or blocked rediscovery never becomes a pass"),
  expectationGuard: evidence("test/subagents-corner.test.js", "H3 corner: expectation guard freezes the contract"),
  nativeBoundary: evidence("test/subagents-corner.test.js", "E1/E2/E3 corner: kind mismatch, missing methods, absent executor block"),
  liveDemo: evidence("test/demo-corner-scenarios.test.js", LIVE_DEMO_TEST),
};

const EVIDENCE_BY_ID = Object.freeze({
  P1: [shared.plannerFallback],
  P2: [shared.plannerFallback],
  P3: [shared.plannerRepair],
  P4: [shared.plannerRepair],
  P5: [
    shared.plannerHonesty,
    evidence("test/generator-hardening.test.js", "assertion validation refutes text and paths the application does not have"),
  ],
  P6: [shared.plannerBrief],
  P7: [
    shared.plannerBrief,
    evidence("test/demo-reset.test.js", "a running demo can reset every app mutation without restarting"),
  ],
  P8: [shared.plannerBrief],
  P9: [shared.plannerIdsAndTrace],
  P10: [shared.plannerIdsAndTrace],
  H1: [
    evidence("test/healing.test.js", "renamed and menu-wrapped checkout action heals with unchanged expectations and evidence"),
    shared.liveDemo,
  ],
  H2: [shared.healingEquivalence, shared.liveDemo],
  H3: [
    shared.expectationGuard,
    evidence("test/healing.test.js", "recovery cannot hide an expectation that still fails"),
    shared.liveDemo,
  ],
  H4: [
    evidence("test/execution-boundaries.test.js", "H4: failed fixture postconditions are functional regressions, never blocked or healed"),
    shared.liveDemo,
  ],
  H5: [shared.healingAbsent],
  H6: [
    shared.healingAbsent,
    evidence("test/healing.test.js", "rediscovery and replacement capability failures never become passes"),
  ],
  H7: [
    evidence("test/healing.test.js", "a genuine broken outcome remains a functional regression after an earlier healed action"),
    shared.liveDemo,
  ],
  H8: [
    evidence("test/healing.test.js", "observable readiness can heal without changing the expected outcome"),
    evidence("test/healing.test.js", "readiness failures and unexpected recovery data block instead of guessing"),
  ],
  D1: [shared.liveDemo],
  D2: [evidence("test/design.test.js", "missing comparison capability and unsupported opinions block instead of guessing")],
  D3: [evidence("test/design.test.js", "design comparison rules normalize only concrete and internally consistent decisions")],
  D4: [evidence("test/design.test.js", "an obvious seeded mismatch becomes an evidence-backed design regression")],
  E1: [shared.nativeBoundary],
  E2: [shared.nativeBoundary],
  E3: [
    shared.nativeBoundary,
    evidence("test/execution.test.js", "missing or mismatched native capabilities persist a clear blocked result"),
  ],
  E4: [
    evidence("test/execution.test.js", "native execution runs login, test steps, cleanup, events, and screenshots end to end"),
    evidence("test/execution-boundaries.test.js", "inspection evidence is redacted and optional driver cleanup errors never replace the result"),
    evidence("test/trace.test.js", "tracer emits ordered entries and redacts secrets"),
  ],
  E5: [
    evidence("test/execution.test.js", "after-fixture failure is recorded without overwriting a passing primary result"),
    shared.liveDemo,
  ],
  E6: [evidence("test/subagents-corner.test.js", "E6 corner: remote orchestration target blocked without flag")],
});

const AREA_NAMES = Object.freeze({
  P: "Planner",
  H: "Healing",
  D: "Design",
  E: "Executor",
});

function plainText(value) {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function readDocumentedCornerCases(markdown = readFileSync(cornerCaseDocument, "utf8")) {
  const cases = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([PHDE]\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
    if (!match) continue;
    const [, id, corner, input, expected] = match;
    cases.push({
      id,
      area: AREA_NAMES[id[0]],
      corner: plainText(corner),
      input: plainText(input),
      expected: plainText(expected),
    });
  }
  return cases;
}

function liveScenariosFor(id) {
  return Object.entries(DEMO_SCENARIO_DETAILS)
    .filter(([, details]) => details.cornerCases.includes(id))
    .map(([scenario, details]) => ({
      scenario,
      command: `npm run demo:reset -- ${scenario}`,
      expected: details.expected,
      description: details.description,
    }));
}

export function buildCornerCaseMatrix() {
  const cases = readDocumentedCornerCases();
  const documentedIds = new Set(cases.map(({ id }) => id));
  const mappedIds = new Set(Object.keys(EVIDENCE_BY_ID));
  const missing = [...documentedIds].filter((id) => !mappedIds.has(id));
  const stale = [...mappedIds].filter((id) => !documentedIds.has(id));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(`Corner-case evidence map is out of sync (missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"})`);
  }
  return cases.map((item) => ({
    ...item,
    evidence: EVIDENCE_BY_ID[item.id],
    liveScenarios: liveScenariosFor(item.id),
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runEvidence(cases) {
  const requestedEvidence = cases.flatMap((item) => item.evidence);
  const uniqueEvidence = [...new Map(requestedEvidence.map((item) => [`${item.file}\0${item.name}`, item])).values()];
  const files = [...new Set(uniqueEvidence.map(({ file }) => file))];
  const names = [...new Set(uniqueEvidence.map(({ name }) => name))];
  const pattern = `^(?:${names.map(escapeRegExp).join("|")})$`;
  const childEnvironment = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  // A demo invocation may itself be exercised by node:test. Do not let the
  // parent's internal test-child marker suppress TAP from this explicit run.
  delete childEnvironment.NODE_TEST_CONTEXT;
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=${pattern}`,
    ...files,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: childEnvironment,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`Corner-case evidence tests exited with status ${result.status}`);
  }

  const passedNames = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!/^ok \d+ - /.test(line) || line.includes(" # SKIP")) continue;
    passedNames.add(line.replace(/^ok \d+ - /, "").trim());
  }
  const missing = uniqueEvidence.filter(({ name }) => !passedNames.has(name));
  if (missing.length > 0) {
    throw new Error(`Evidence tests did not report a pass: ${missing.map(({ name }) => name).join("; ")}`);
  }

  return {
    durationMs: Date.now() - startedAt,
    files,
    tests: names,
    passedNames,
  };
}

function parseArguments(args) {
  const options = { verify: true, json: false, caseId: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--list") options.verify = false;
    else if (argument === "--json") options.json = true;
    else if (argument === "--case") options.caseId = args[++index]?.toUpperCase();
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (args.at(-1) === "--case" || (options.caseId !== undefined && !/^[PHDE]\d+$/.test(options.caseId))) {
    throw new Error("--case requires an ID such as P3, H7, D2, or E5");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run demo:corners -- [--case <ID>] [--list] [--json]

With no options, runs the focused executable evidence for all documented corner cases.
--case verifies one case and prints its exact contract and any live demo scenario.
--list prints the complete matrix without running tests.
--json emits machine-readable output.`);
}

function printHuman(cases, verification) {
  console.log("Autonomous QA corner-case drill");
  if (verification) {
    console.log(`Evidence: ${verification.tests.length} focused tests across ${verification.files.length} files passed in ${verification.durationMs}ms.`);
  } else {
    console.log("Evidence: not run (--list).");
  }

  let currentArea;
  for (const item of cases) {
    if (item.area !== currentArea) {
      currentArea = item.area;
      const count = cases.filter(({ area }) => area === currentArea).length;
      console.log(`\n${currentArea} (${count})`);
    }
    const mark = verification ? "✓" : "•";
    console.log(`${mark} ${item.id} ${item.corner} → ${item.expected}`);
    for (const live of item.liveScenarios) {
      console.log(`    live: ${live.command} → ${live.expected}`);
    }
  }

  if (cases.some(({ id }) => id === "P7")) {
    console.log("\nP7 live target: run the planner against http://127.0.0.1:3000/spa-shell while the demo app is running.");
  }
  if (verification) console.log(`\n${cases.length}/${cases.length} selected corner-case contracts have green executable evidence.`);
}

export function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    printHelp();
    return 0;
  }
  let cases = buildCornerCaseMatrix();
  if (options.caseId) {
    cases = cases.filter(({ id }) => id === options.caseId);
    if (cases.length === 0) throw new Error(`Unknown corner-case ID: ${options.caseId}`);
  }
  const verification = options.verify ? runEvidence(cases) : undefined;
  const payload = {
    verified: verification ? true : null,
    count: cases.length,
    evidence: verification ? {
      tests: verification.tests.length,
      files: verification.files.length,
      durationMs: verification.durationMs,
    } : null,
    cases: cases.map((item) => ({
      ...item,
      verified: verification ? item.evidence.every(({ name }) => verification.passedNames.has(name)) : null,
    })),
  };
  if (options.json) console.log(JSON.stringify(payload, null, 2));
  else printHuman(cases, verification);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
