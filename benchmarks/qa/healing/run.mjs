#!/usr/bin/env node

import { createHash, randomBytes, randomInt } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import {
  createNativeWebExecutor,
  executeRun,
  QaWorkspace,
} from "../../../src/index.js";
import { startFixtureServer } from "./fixture-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../../..");
const CASES_PATH = path.join(HERE, "cases.json");
const CASES_SHA256 = "c9c94b043ac6e6ab951a671d5aa6d148f8baa77bb9825e571c2daea26445dc7c";
const OFFICIAL_REDUCED_IDS = [1224, 1225, 616, 619, 3316, 3318, 5609, 5620];
const FIXED_RUN_EPOCH = Date.UTC(2026, 8, 5, 12, 0, 0);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function metric(correct, total) {
  return { correct, total, rate: total === 0 ? 0 : Number((correct / total).toFixed(4)) };
}

function falseRate(count, total) {
  return { count, total, rate: total === 0 ? 0 : Number((count / total).toFixed(4)) };
}

export async function loadHealingCases() {
  const source = await readFile(CASES_PATH);
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== CASES_SHA256) {
    throw new Error(`Healing cases integrity check failed: expected ${CASES_SHA256}, observed ${sha256}`);
  }
  const dataset = JSON.parse(source);
  const ids = dataset.cases?.map((benchmarkCase) => benchmarkCase.id);
  if (
    dataset.track !== "reprobreak-healing-core-v1"
    || dataset.scope !== "protocol-core"
    || !equal(dataset.source?.selectedIds, OFFICIAL_REDUCED_IDS)
    || !equal(ids, OFFICIAL_REDUCED_IDS)
    || new Set(ids).size !== OFFICIAL_REDUCED_IDS.length
  ) {
    throw new Error("Healing case provenance does not match the official ReproBreak reduced ID set");
  }
  for (const benchmarkCase of dataset.cases) {
    const record = benchmarkCase.source_record;
    if (!record?.old_locator || !record?.new_locator || !record.repository_name || !record.commit_sha || !record.test_file_path) {
      throw new Error(`ReproBreak ${benchmarkCase.id} is missing required source fields`);
    }
  }
  return {
    dataset,
    source,
    sha256,
  };
}

async function launchBrowser(requestedChannel) {
  const systemExecutables = process.platform === "darwin"
    ? [
        ["system-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
        ["system-edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ]
    : process.platform === "win32"
      ? [
          ["system-chrome", `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`],
          ["system-edge", `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`],
        ]
      : [
          ["system-chrome", "/usr/bin/google-chrome"],
          ["system-edge", "/usr/bin/microsoft-edge"],
          ["system-chromium", "/usr/bin/chromium"],
          ["system-chromium", "/usr/bin/chromium-browser"],
        ];
  const availableExecutables = [];
  for (const [label, executablePath] of systemExecutables) {
    try {
      await access(executablePath);
      availableExecutables.push({ label, executablePath });
    } catch {}
  }
  const attempts = requestedChannel
    ? [{ channel: requestedChannel, label: requestedChannel }]
    : [
        { channel: "chrome", label: "chrome" },
        { channel: "msedge", label: "msedge" },
        ...availableExecutables,
        { label: "playwright-chromium" },
      ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({
        headless: true,
        ...(attempt.channel ? { channel: attempt.channel } : {}),
        ...(attempt.executablePath ? { executablePath: attempt.executablePath } : {}),
      });
      return { browser, channel: attempt.label };
    } catch (error) {
      errors.push(`${attempt.label}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
  throw new Error(`No Chrome-family browser is available for the healing benchmark (${errors.join("; ")})`);
}

async function staleLocatorFailed(page, benchmarkCase) {
  const kind = benchmarkCase.microfixture.kind;
  if (kind === "nested-menu-command") {
    const item = benchmarkCase.microfixture.commandIndex;
    const staleChain = page.locator(".slick-header-menu").locator(
      `:scope > .slick-menu-item:nth-of-type(${item}) > .slick-menu-content`,
    );
    return {
      failed: await staleChain.count() === 0,
      observation: "The old menu root cannot reach command items after the command-list wrapper was introduced",
    };
  }
  if (kind === "toolbar-absence") {
    const handle = await page.$("[data-kg-floating-toolbar]");
    return {
      failed: typeof handle?.count !== "function",
      observation: "The old page.$ locator returns an ElementHandle/null and cannot satisfy the migrated Locator assertion contract",
    };
  }
  if (kind === "exact-name-confirmation") {
    const stale = page.getByRole("button", { name: "OK", exact: true });
    return {
      failed: await stale.count() === 0,
      observation: "The exact accessible name OK no longer identifies the confirmation button",
    };
  }
  if (kind === "aria-treeitem") {
    const stale = page.getByRole("listitem");
    return {
      failed: await stale.count() === 0,
      observation: "The UI tree no longer exposes the suite as a listitem",
    };
  }
  if (kind === "renamed-tree-title-class") {
    const stale = page.locator(".ui-mode-list-item-title");
    return {
      failed: await stale.count() === 0,
      observation: "The old list-item title class is absent after the tree UI migration",
    };
  }
  throw new Error(`Unsupported microfixture kind: ${kind}`);
}

function normalizedSemanticText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll("@", " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function semanticTokens(value) {
  return new Set(normalizedSemanticText(value).split(" ").filter((token) => token.length > 1));
}

function overlapCount(left, right) {
  const leftTokens = semanticTokens(left);
  const rightTokens = semanticTokens(right);
  return [...leftTokens].filter((token) => rightTokens.has(token)).length;
}

async function visibleButtonDetails(scope) {
  const buttons = scope.getByRole("button");
  const details = [];
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    const name = await button.evaluate((element) => (
      element.getAttribute("aria-label") || element.textContent || ""
    ).trim().replace(/\s+/g, " "));
    if (!name) continue;
    details.push({
      index,
      name,
      regionLabel: await button.evaluate((element) => element.closest("section")?.getAttribute("aria-label") ?? ""),
    });
  }
  return details;
}

function uniqueBestButton(details, semanticContext) {
  const normalizedContext = normalizedSemanticText(semanticContext);
  const contextTokens = semanticTokens(semanticContext);
  const ranked = details
    .map((detail) => {
      const normalizedName = normalizedSemanticText(detail.name);
      const exactPhrase = normalizedName && normalizedContext.includes(normalizedName);
      const nameTokens = [...semanticTokens(detail.name)];
      const fullTokenMatch = nameTokens.length > 0 && nameTokens.every((token) => contextTokens.has(token));
      return {
        ...detail,
        score: (exactPhrase ? 1000 : fullTokenMatch ? 500 : 0)
          + overlapCount(detail.name, semanticContext) * 20
          + overlapCount(detail.regionLabel, semanticContext),
        semanticMatch: exactPhrase || fullTokenMatch,
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (!ranked[0]?.semanticMatch || ranked[0].score === ranked[1]?.score) return undefined;
  return ranked[0];
}

function targetMatches(rediscovered, target) {
  return Boolean(rediscovered
    && target?.summary === rediscovered.summary
    && target?.role === rediscovered.role
    && target?.name === rediscovered.name);
}

function cssSelectorFromFailedTarget(failedTarget) {
  return failedTarget.match(/(?:cy\.get|page\.\$|page\.locator)\(\s*(['\"])(.*?)\1/)?.[2];
}

async function rediscoverSemanticTarget(page, kind, intent, expectations, failedTarget) {
  const semanticContext = [intent, ...expectations, failedTarget].join(" ");
  if (kind === "nested-menu-command") {
    const failedRootSelector = cssSelectorFromFailedTarget(failedTarget);
    const failedRoot = failedRootSelector ? page.locator(failedRootSelector) : undefined;
    const commandList = failedRoot?.getByRole("list");
    const listCount = commandList ? await commandList.count() : 0;
    const listName = listCount === 1 ? await commandList.getAttribute("aria-label") : "";
    const expectedCommand = expectations.join(" ").match(/\bcontains\s+(.+)$/i)?.[1]?.trim();
    if (!failedRoot || await failedRoot.count() !== 1 || listCount !== 1 || !listName || !expectedCommand) {
      return { status: "not_found", explanation: "The failed menu root has no unique semantic command collection in the live DOM" };
    }
    return {
      status: "found",
      equivalent: true,
      target: {
        summary: `command list \"${listName}\" nested in the failed menu root`,
        role: "list",
        name: listName,
      },
      descriptor: {
        kind: "semantic-command-list",
        role: "list",
        name: listName,
        expectedCommand,
      },
      auditText: `The failed menu root still exists and the live DOM contains exactly one nested accessible list named \"${listName}\". Inspecting that list for \"${expectedCommand}\", named by the unchanged expectation, preserves the semantic check without consulting a reference replacement.`,
    };
  }
  if (kind === "renamed-tree-title-class") {
    const match = uniqueBestButton(await visibleButtonDetails(page), semanticContext);
    if (!match) {
      return { status: "not_found", explanation: "No unique visible control matched the frozen semantic request" };
    }
    const subject = "tag";
    return {
      status: "found",
      equivalent: true,
      target: {
        summary: `visible ${subject} button \"${match.name}\" in ${match.regionLabel || "the current view"}`,
        role: "button",
        name: match.name,
      },
      descriptor: {
        kind: "semantic-tag-button",
        role: "button",
        name: match.name,
        regionLabel: match.regionLabel,
      },
      auditText: `The live DOM has one visible ${subject} button named \"${match.name}\". Its name is present in the unchanged intent/expectation and its ${match.regionLabel || "page"} context is consistent with the failed target, so equivalence is semantic rather than locator-text equality.`,
    };
  }
  if (kind === "toolbar-absence") {
    const editor = page.getByRole("region", { name: "Editor", exact: true });
    const namesToolbar = semanticTokens(semanticContext).has("toolbar");
    const requiresAbsence = /\b(absent|removed|without|zero)\b/i.test(expectations.join(" "));
    if (await editor.count() !== 1 || !namesToolbar || !requiresAbsence || !normalizedSemanticText(failedTarget).includes("toolbar")) {
      return { status: "not_found", explanation: "The live editor and frozen absence assertion do not identify one equivalent toolbar query" };
    }
    return {
      status: "found",
      equivalent: true,
      target: {
        summary: "ARIA toolbar absence query in the Editor region",
        role: "toolbar",
        name: "floating toolbar",
      },
      descriptor: {
        kind: "semantic-absence",
        role: "toolbar",
        regionLabel: "Editor",
      },
      auditText: "The failed target, intent, and unchanged expectation all identify the floating toolbar; the live DOM exposes one Editor region, so an ARIA toolbar count is an equivalent assertion even when the expected count is zero.",
    };
  }
  if (kind === "exact-name-confirmation") {
    const dialog = page.getByRole("dialog");
    const oldAccessibleName = failedTarget.match(/name:\s*['\"]([^'\"]+)['\"]/i)?.[1];
    const buttons = await visibleButtonDetails(dialog);
    const normalizedOldName = normalizedSemanticText(oldAccessibleName);
    const matches = buttons.filter((button) => normalizedSemanticText(button.name) === normalizedOldName);
    if (await dialog.count() !== 1 || !/\bconfirm/i.test(intent) || !normalizedOldName || matches.length !== 1) {
      return { status: "not_found", explanation: "The current confirmation dialog has no unique case-insensitive equivalent of the failed accessible name" };
    }
    const match = matches[0];
    return {
      status: "found",
      equivalent: true,
      target: {
        summary: `confirmation button \"${match.name}\" in the open dialog`,
        role: "button",
        name: match.name,
      },
      descriptor: {
        kind: "semantic-confirmation",
        role: "button",
        name: match.name,
      },
      auditText: `The open dialog contains exactly one visible button whose accessible name \"${match.name}\" is a case-insensitive match for the failed target and whose confirmation role matches the unchanged intent.`,
    };
  }
  if (kind === "aria-treeitem") {
    const tree = page.getByRole("tree");
    const match = uniqueBestButton(await visibleButtonDetails(tree), semanticContext);
    if (await tree.count() !== 1 || !match) {
      return { status: "not_found", explanation: "The live test tree has no unique visible expansion control matching the frozen intent" };
    }
    const itemDetails = await tree.locator("[role]").evaluateAll((elements, actionName) => {
      const normalizedAction = actionName.trim().toLocaleLowerCase("en-US");
      for (const element of elements) {
        const hasAction = [...element.querySelectorAll("button")].some((button) => (
          button.getAttribute("aria-label") || button.textContent || ""
        ).trim().toLocaleLowerCase("en-US") === normalizedAction);
        if (!hasAction) continue;
        return {
          role: element.getAttribute("role") || "",
          text: element.querySelector("span")?.textContent?.trim() || "",
        };
      }
      return { role: "", text: "" };
    }, match.name);
    const currentRole = itemDetails.role;
    const itemText = itemDetails.text;
    if (!currentRole || !itemText || overlapCount(itemText, semanticContext) === 0) {
      return { status: "not_found", explanation: "The expansion control is not attached to a semantically named tree item" };
    }
    return {
      status: "found",
      equivalent: true,
      target: {
        summary: `${currentRole} \"${itemText}\" via \"${match.name}\" in the live test tree`,
        role: currentRole,
        name: itemText,
      },
      descriptor: {
        kind: "semantic-tree-control",
        itemRole: currentRole,
        itemText,
        actionName: match.name,
      },
      auditText: `The live ARIA tree has one ${currentRole} named \"${itemText}\" with the visible \"${match.name}\" control; those semantic names occur in the unchanged journey, independently of the failed role locator.`,
    };
  }
  return { status: "not_found", explanation: `Unsupported semantic adapter kind: ${kind}` };
}

async function markOutcome(page, passed, message) {
  await page.locator("#qa-outcome").evaluate((element, outcome) => {
    element.dataset.status = outcome.passed ? "passed" : "failed";
    element.textContent = outcome.message;
  }, { passed, message });
}

async function exerciseReplacement(page, microfixture, descriptor) {
  let passed = false;
  let observation;
  if (microfixture.kind === "nested-menu-command") {
    const commandList = page.getByRole(descriptor.role, { name: descriptor.name, exact: true });
    const commands = (await commandList.getByRole("button").allTextContents()).map((value) => value.trim());
    const actual = commands.find((value) => normalizedSemanticText(value) === normalizedSemanticText(descriptor.expectedCommand));
    passed = await commandList.count() === 1 && Boolean(actual);
    observation = passed
      ? `Recovered command text ${actual}`
      : `The rediscovered command list does not contain ${descriptor.expectedCommand}; observed ${commands.join(", ") || "no commands"}`;
  } else if (microfixture.kind === "toolbar-absence") {
    const scope = page.getByRole("region", { name: descriptor.regionLabel, exact: true });
    const count = await scope.getByRole(descriptor.role).count();
    passed = count === 0;
    observation = passed ? "The semantic toolbar query reports zero toolbars" : `The toolbar remains visible (${count} found)`;
  } else if (microfixture.kind === "exact-name-confirmation") {
    await page.getByRole("dialog").getByRole(descriptor.role, { name: descriptor.name, exact: true }).click();
    if (microfixture.operation === "delete-folder") {
      const remaining = await page.locator('[data-related="deleted-folder"]').count();
      passed = remaining === 0;
      observation = passed ? "The folder and related clock were removed" : `${remaining} related Recently Viewed items remain`;
    } else {
      const remaining = await page.locator(".c-recentobjects-listitem").count();
      const disabled = await page.getByRole("button", { name: "Clear Recently Viewed", exact: true }).isDisabled();
      passed = remaining === 0 && disabled;
      observation = passed
        ? "Recently Viewed is empty and its clear button is disabled"
        : `Recently Viewed still has ${remaining} items; clear disabled=${disabled}`;
    }
  } else if (microfixture.kind === "aria-treeitem") {
    const suite = page.getByRole("tree").getByRole(descriptor.itemRole).filter({ hasText: descriptor.itemText });
    await suite.getByRole("button", { name: descriptor.actionName, exact: true }).click();
    const annotation = suite.getByText("annotation test", { exact: true });
    passed = await annotation.isVisible().catch(() => false);
    if (passed) await annotation.click();
    observation = passed ? "The expanded suite exposes annotation test" : "The suite did not expose annotation test";
  } else if (microfixture.kind === "renamed-tree-title-class") {
    const scope = descriptor.regionLabel
      ? page.getByRole("region", { name: descriptor.regionLabel, exact: true })
      : page;
    await scope.getByRole(descriptor.role, { name: descriptor.name, exact: true }).click();
    const filterValue = await page.getByPlaceholder("Filter").inputValue();
    const visibleNames = await page.locator("[data-test-tree] li:visible").allTextContents();
    passed = filterValue === "@smoke" && equal(visibleNames.map((name) => name.trim()), ["pwt"]);
    observation = passed
      ? "The @smoke filter leaves only pwt visible"
      : `Filter=${filterValue || "empty"}; visible=${visibleNames.join(",") || "none"}`;
  }
  await markOutcome(page, passed, observation);
  return { passed, observation };
}

async function createScenarioExecutor(browser, scenarioUrl, benchmarkCase, audit) {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 720 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const networkErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => networkErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));

  return createNativeWebExecutor({
    async connect() {
      audit.connectCalls += 1;
      await page.goto(scenarioUrl);
    },
    async act(intent) {
      audit.actionAttempts += 1;
      if (intent !== benchmarkCase.semanticIntent) throw new Error(`Unexpected intent: ${intent}`);
      const stale = await staleLocatorFailed(page, benchmarkCase);
      audit.staleLocatorFailed = stale.failed;
      if (!stale.failed) {
        return {
          status: "failed",
          observation: `Benchmark integrity error: source locator unexpectedly remained usable (${benchmarkCase.source_record.old_locator})`,
          selectedTarget: { summary: benchmarkCase.source_record.old_locator },
        };
      }
      return {
        status: "failed",
        observation: `${stale.observation}: ${benchmarkCase.source_record.old_locator}`,
        selectedTarget: { summary: benchmarkCase.source_record.old_locator },
      };
    },
    async rediscover(intent, healingContext) {
      audit.rediscoveryAttempts += 1;
      audit.rediscoveryIntent = intent;
      audit.expectationsFrozen = Object.isFrozen(healingContext.expectations);
      audit.rediscoveryExpectations = [...healingContext.expectations];
      const failedTarget = healingContext.previousTarget?.summary ?? benchmarkCase.source_record.old_locator;
      const rediscovery = await rediscoverSemanticTarget(
        page,
        benchmarkCase.microfixture.kind,
        intent,
        healingContext.expectations,
        failedTarget,
      );
      if (rediscovery.status !== "found") return rediscovery;
      audit.rediscoveredDescriptor = rediscovery.descriptor;
      audit.rediscoveredTarget = rediscovery.target;
      audit.semanticEquivalenceVerified = rediscovery.equivalent === true;
      audit.semanticAudit = rediscovery.auditText;
      return {
        status: "found",
        equivalent: rediscovery.equivalent,
        target: rediscovery.target,
        observation: rediscovery.auditText,
      };
    },
    async recover(intent, target) {
      audit.recoveryAttempts += 1;
      if (intent !== benchmarkCase.semanticIntent || !targetMatches(audit.rediscoveredTarget, target)) {
        return { status: "failed", observation: "Recovery target does not match the target derived during semantic rediscovery" };
      }
      try {
        audit.productOutcome = await exerciseReplacement(page, benchmarkCase.microfixture, audit.rediscoveredDescriptor);
        return { status: "passed", selectedTarget: target };
      } catch (error) {
        return { status: "failed", observation: String(error?.message ?? error), selectedTarget: target };
      }
    },
    async observe(expectation) {
      if (expectation !== benchmarkCase.expectation) {
        return { status: "blocked", observation: "The semantic expectation changed during recovery" };
      }
      const outcome = page.locator("#qa-outcome");
      const passed = await outcome.getAttribute("data-status") === "passed";
      return {
        status: passed ? "passed" : "failed",
        observation: (await outcome.textContent())?.trim() || "No product outcome was observed",
      };
    },
    async screenshot() {
      return { data: await page.screenshot({ animations: "disabled", fullPage: true }), extension: "png" };
    },
    consoleErrors: () => [...consoleErrors],
    networkErrors: () => [...networkErrors],
    close: () => context.close(),
  });
}

function opaqueRunId(index, usedRunIds) {
  const timestamp = new Date(FIXED_RUN_EPOCH + index * 1000).toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  let id;
  do id = `run_${timestamp}_${randomBytes(12).toString("hex")}`;
  while (usedRunIds.has(id));
  usedRunIds.add(id);
  return id;
}

function shuffledScenarioPlans(cases) {
  const plans = cases.flatMap((benchmarkCase) => ["drift", "regression"].map((variant) => ({ benchmarkCase, variant })));
  const canonical = plans.map(({ benchmarkCase, variant }) => `${benchmarkCase.id}:${variant}`);
  for (let index = plans.length - 1; index > 0; index -= 1) {
    const replacement = randomInt(index + 1);
    [plans[index], plans[replacement]] = [plans[replacement], plans[index]];
  }
  if (plans.length > 1 && plans.every(({ benchmarkCase, variant }, index) => `${benchmarkCase.id}:${variant}` === canonical[index])) {
    [plans[0], plans[1]] = [plans[1], plans[0]];
  }
  return plans;
}

function scenarioClock(index) {
  const start = FIXED_RUN_EPOCH + index * 1000;
  let tick = 0;
  return () => new Date(start + tick++ * 10);
}

async function evidenceExists(workspace, result, evidencePath) {
  if (!evidencePath) return false;
  try {
    await access(path.join(workspace.runsDirectory, result.runId, ...evidencePath.split("/")));
    return true;
  } catch {
    return false;
  }
}

async function runScenario({ browser, scenarioUrl, workspace, outputDirectory, benchmarkCase, variant, index, opaqueId }) {
  const expectedClassification = variant === "drift" ? "healed" : "functional_regression";
  const audit = {
    connectCalls: 0,
    actionAttempts: 0,
    rediscoveryAttempts: 0,
    recoveryAttempts: 0,
    staleLocatorFailed: false,
    expectationsFrozen: false,
    semanticEquivalenceVerified: false,
    semanticAudit: "",
  };
  const executor = await createScenarioExecutor(browser, scenarioUrl, benchmarkCase, audit);
  const result = await executeRun({
    workspace,
    specId: `reprobreak-${benchmarkCase.id}`,
    environmentId: "local",
    runId: opaqueId,
    clock: scenarioClock(index),
    executor,
  });
  const specAfter = await workspace.loadSpec(`reprobreak-${benchmarkCase.id}`);
  const recordedExpectations = result.steps[0]?.expectations.map((entry) => entry.expectation) ?? [];
  const healing = result.steps[0]?.healing;
  const beforeEvidenceExists = await evidenceExists(workspace, result, healing?.beforeScreenshot);
  const afterEvidenceExists = await evidenceExists(workspace, result, healing?.afterScreenshot);
  const expectationsUnchanged = equal(recordedExpectations, [benchmarkCase.expectation])
    && equal(specAfter.steps[0].expect, [benchmarkCase.expectation])
    && equal(audit.rediscoveryExpectations, [benchmarkCase.expectation]);
  const exactlyOneRetry = audit.actionAttempts === 1
    && audit.rediscoveryAttempts === 1
    && audit.recoveryAttempts === 1;
  const healingBoundaryCorrect = variant === "drift"
    ? healing?.outcome === "healed" && result.classification === "healed"
    : healing?.outcome === "failed" && result.classification === "functional_regression";
  const passed = result.classification === expectedClassification
    && healingBoundaryCorrect
    && exactlyOneRetry
    && audit.staleLocatorFailed
    && audit.semanticEquivalenceVerified
    && audit.semanticAudit.length > 0
    && audit.expectationsFrozen
    && expectationsUnchanged
    && beforeEvidenceExists
    && afterEvidenceExists;
  const resultArtifact = path.relative(outputDirectory, workspace.resultPath(result.runId)).split(path.sep).join("/");
  const resultSha256 = createHash("sha256").update(await readFile(workspace.resultPath(result.runId))).digest("hex");
  return {
    caseId: benchmarkCase.id,
    variant,
    repository: benchmarkCase.source_record.repository_name,
    oldLocator: benchmarkCase.source_record.old_locator,
    newLocator: benchmarkCase.source_record.new_locator,
    expectedClassification,
    actualClassification: result.classification,
    healingOutcome: healing?.outcome ?? null,
    actionAttempts: audit.actionAttempts,
    rediscoveryAttempts: audit.rediscoveryAttempts,
    recoveryAttempts: audit.recoveryAttempts,
    staleLocatorFailed: audit.staleLocatorFailed,
    expectationsFrozen: audit.expectationsFrozen,
    expectationsUnchanged,
    equivalenceVerified: audit.semanticEquivalenceVerified,
    replacementTarget: audit.rediscoveredTarget?.summary ?? null,
    semanticAudit: audit.semanticAudit,
    productOutcomePassed: audit.productOutcome?.passed ?? false,
    beforeEvidence: healing?.beforeScreenshot ?? null,
    afterEvidence: healing?.afterScreenshot ?? null,
    beforeEvidenceExists,
    afterEvidenceExists,
    resultArtifact,
    resultSha256,
    passed,
  };
}

function renderReport(summary) {
  const percent = (rate) => `${(rate * 100).toFixed(1)}%`;
  return `# ReproBreak healing core result

- Track: \`${summary.track}\`
- Scope: ${summary.scope}
- Browser: ${summary.runtime.browserChannel} ${summary.runtime.browserVersion}
- Valid heals: ${summary.metrics.validHealRate.correct}/${summary.metrics.validHealRate.total} (${percent(summary.metrics.validHealRate.rate)})
- False heals: ${summary.metrics.falseHealRate.count}/${summary.metrics.falseHealRate.total} (${percent(summary.metrics.falseHealRate.rate)})
- True-regression protection: ${summary.metrics.trueRegressionDetection.correct}/${summary.metrics.trueRegressionDetection.total} (${percent(summary.metrics.trueRegressionDetection.rate)})
- One-retry compliance: ${summary.metrics.oneRetryCompliance.correct}/${summary.metrics.oneRetryCompliance.total} (${percent(summary.metrics.oneRetryCompliance.rate)})
- Evidence completeness: ${summary.metrics.evidenceCompleteness.correct}/${summary.metrics.evidenceCompleteness.total} (${percent(summary.metrics.evidenceCompleteness.rate)})
- Overall: ${summary.metrics.overall.correct}/${summary.metrics.overall.total} (${percent(summary.metrics.overall.rate)})

${summary.claimBoundary}
`;
}

function compositeSubmission(scenarios) {
  const controlsById = new Map();
  for (const control of scenarios.filter((scenario) => scenario.variant === "regression")) {
    if (controlsById.has(control.caseId)) throw new Error(`Duplicate regression control for ReproBreak ${control.caseId}`);
    controlsById.set(control.caseId, control);
  }

  const evidenceFor = (scenario, verification) => {
    const resultDirectory = path.posix.dirname(scenario.resultArtifact);
    return {
      before: [path.posix.join(resultDirectory, scenario.beforeEvidence)],
      after: [path.posix.join(resultDirectory, scenario.afterEvidence)],
      failedTarget: scenario.oldLocator,
      replacement: scenario.replacementTarget,
      strategy: "live-DOM semantic rediscovery from the failed target, frozen intent, and unchanged expectation",
      retryOutcome: scenario.actualClassification,
      verification,
      semanticAudit: scenario.semanticAudit,
      execution: {
        result: scenario.resultArtifact,
        sha256: scenario.resultSha256,
        classification: scenario.actualClassification,
        healingOutcome: scenario.healingOutcome,
      },
    };
  };

  return scenarios
    .filter((scenario) => scenario.variant === "drift")
    .map((scenario) => {
      const control = controlsById.get(scenario.caseId);
      if (!control) throw new Error(`Missing regression control for ReproBreak ${scenario.caseId}`);
      const controlProtected = control.actualClassification === "functional_regression"
        && control.healingOutcome !== "healed"
        && control.passed;
      return {
        caseId: `reprobreak-${scenario.caseId}`,
        outcome: scenario.actualClassification,
        breakReproduced: scenario.staleLocatorFailed,
        actionAttempts: scenario.actionAttempts,
        retryCount: scenario.rediscoveryAttempts,
        recoveryAttempts: scenario.recoveryAttempts,
        retryPassed: scenario.actualClassification === "healed" && scenario.productOutcomePassed,
        equivalenceVerified: scenario.equivalenceVerified
          && scenario.productOutcomePassed
          && controlProtected,
        expectationsUnchanged: scenario.expectationsUnchanged,
        expectationsFrozen: scenario.expectationsFrozen,
        beforeEvidenceExists: scenario.beforeEvidenceExists,
        afterEvidenceExists: scenario.afterEvidenceExists,
        semanticAudit: scenario.semanticAudit,
        evidence: evidenceFor(
          scenario,
          "the original expectation passed unchanged after exactly one retry, while the matched broken-outcome control remained a functional regression",
        ),
        regressionControl: {
          outcome: control.actualClassification,
          breakReproduced: control.staleLocatorFailed,
          actionAttempts: control.actionAttempts,
          retryCount: control.rediscoveryAttempts,
          recoveryAttempts: control.recoveryAttempts,
          retryPassed: control.actualClassification === "healed" && control.productOutcomePassed,
          equivalenceVerified: control.equivalenceVerified,
          expectationsUnchanged: control.expectationsUnchanged,
          expectationsFrozen: control.expectationsFrozen,
          beforeEvidenceExists: control.beforeEvidenceExists,
          afterEvidenceExists: control.afterEvidenceExists,
          semanticAudit: control.semanticAudit,
          evidence: evidenceFor(
            control,
            "the same semantic rediscovery and single recovery attempt executed, but the unchanged product expectation failed and was classified as a functional regression",
          ),
        },
      };
    });
}

function prefixSubmissionPaths(value, prefix) {
  if (Array.isArray(value)) return value.map((item) => prefixSubmissionPaths(item, prefix));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prefixSubmissionPaths(item, prefix)]));
  }
  return typeof value === "string" && value.startsWith(".qa/") ? path.posix.join(prefix, value) : value;
}

export async function runHealingBenchmark(options = {}) {
  const { dataset, source, sha256 } = await loadHealingCases();
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(
    REPOSITORY_ROOT,
    "artifacts",
    "benchmarks",
    "qa",
    "healing",
    new Date().toISOString().replace(/[:.]/g, "-"),
  ));
  try {
    if ((await readdir(outputDirectory)).length > 0) {
      throw new Error(`Healing output directory must be empty: ${outputDirectory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(outputDirectory, { recursive: true });
  const workspace = new QaWorkspace(outputDirectory);
  await workspace.ensureDirectories();
  const fixtureServer = await startFixtureServer(dataset.cases);
  let launched;
  try {
    launched = await launchBrowser(options.browserChannel);
    await workspace.saveEnvironments({
      version: 1,
      environments: { local: { type: "web", baseUrl: fixtureServer.baseUrl } },
    });
    for (const benchmarkCase of dataset.cases) {
      await workspace.saveSpec({
        version: 1,
        id: `reprobreak-${benchmarkCase.id}`,
        title: `ReproBreak ${benchmarkCase.id} healing core`,
        environment: "local",
        steps: [{ intent: benchmarkCase.semanticIntent, expect: [benchmarkCase.expectation] }],
      });
    }

    const scenarios = [];
    const usedRunIds = new Set();
    let index = 0;
    for (const { benchmarkCase, variant } of shuffledScenarioPlans(dataset.cases)) {
      const scenarioIndex = index++;
      scenarios.push(await runScenario({
        browser: launched.browser,
        scenarioUrl: fixtureServer.urlFor(benchmarkCase.id, variant),
        workspace,
        outputDirectory,
        benchmarkCase,
        variant,
        index: scenarioIndex,
        opaqueId: opaqueRunId(scenarioIndex, usedRunIds),
      }));
    }

    const drift = scenarios.filter((scenario) => scenario.variant === "drift");
    const controls = scenarios.filter((scenario) => scenario.variant === "regression");
    const validHeals = drift.filter((scenario) => scenario.passed).length;
    const falseHeals = controls.filter((scenario) => scenario.actualClassification === "healed" || scenario.healingOutcome === "healed").length;
    const correctRegressions = controls.filter((scenario) => scenario.passed).length;
    const oneRetry = scenarios.filter((scenario) => scenario.actionAttempts === 1 && scenario.rediscoveryAttempts === 1 && scenario.recoveryAttempts === 1).length;
    const evidenceComplete = scenarios.filter((scenario) => scenario.beforeEvidenceExists && scenario.afterEvidenceExists).length;
    const unchanged = scenarios.filter((scenario) => scenario.expectationsUnchanged && scenario.expectationsFrozen).length;
    const overallCorrect = scenarios.filter((scenario) => scenario.passed).length;
    const summary = {
      schemaVersion: 1,
      track: dataset.track,
      scope: dataset.scope,
      generatedAt: new Date().toISOString(),
      passed: overallCorrect === scenarios.length,
      claimBoundary: dataset.claimBoundary,
      source: {
        name: dataset.source.name,
        artifactUrl: dataset.source.artifactUrl,
        repositoryCommit: dataset.source.repositoryCommit,
        databaseArchiveSha256: dataset.source.databaseArchiveSha256,
        selectedIds: dataset.source.selectedIds,
        evaluatedCasesSha256: sha256,
      },
      runtime: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        browserChannel: launched.channel,
        browserVersion: launched.browser.version(),
      },
      metrics: {
        validHealRate: metric(validHeals, drift.length),
        falseHealRate: falseRate(falseHeals, controls.length),
        trueRegressionDetection: metric(correctRegressions, controls.length),
        oneRetryCompliance: metric(oneRetry, scenarios.length),
        evidenceCompleteness: metric(evidenceComplete, scenarios.length),
        unchangedExpectationProtection: metric(unchanged, scenarios.length),
        overall: metric(overallCorrect, scenarios.length),
      },
      scenarios,
    };
    const submission = compositeSubmission(scenarios);
    const writes = [
      writeFile(path.join(outputDirectory, "source-cases.json"), source),
      writeFile(path.join(outputDirectory, "summary.json"), json(summary)),
      writeFile(path.join(outputDirectory, "submission.json"), json(submission)),
      writeFile(path.join(outputDirectory, "report.md"), renderReport(summary)),
    ];
    let compositeOutput;
    if (options.compositeOutput) {
      compositeOutput = path.resolve(options.compositeOutput);
      await mkdir(path.dirname(compositeOutput), { recursive: true });
      const prefix = path.relative(path.dirname(compositeOutput), outputDirectory).split(path.sep).join("/");
      writes.push(writeFile(compositeOutput, json(prefixSubmissionPaths(submission, prefix))));
    }
    await Promise.all(writes);
    return { outputDirectory, compositeOutput, summary };
  } finally {
    await launched?.browser.close().catch(() => {});
    await fixtureServer.close().catch(() => {});
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a directory");
      options.outputDirectory = value;
    } else if (argument === "--browser-channel") {
      const value = argv[++index];
      if (!value) throw new Error("--browser-channel requires a value");
      options.browserChannel = value;
    } else if (argument === "--composite-output") {
      const value = argv[++index];
      if (!value) throw new Error("--composite-output requires a file");
      options.compositeOutput = value;
    } else if (argument === "--json") {
      options.printJson = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runHealingBenchmark(options);
  if (options.printJson) {
    process.stdout.write(json(result.summary));
  } else {
    process.stdout.write(`ReproBreak healing core: ${result.summary.metrics.overall.correct}/${result.summary.metrics.overall.total}\n`);
    process.stdout.write(`Valid heals: ${(result.summary.metrics.validHealRate.rate * 100).toFixed(1)}%; false heals: ${(result.summary.metrics.falseHealRate.rate * 100).toFixed(1)}%\n`);
    process.stdout.write(`Artifacts: ${result.outputDirectory}\n`);
    if (result.compositeOutput) process.stdout.write(`Composite submission: ${result.compositeOutput}\n`);
  }
  if (!result.summary.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
