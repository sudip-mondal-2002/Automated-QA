export { draftSpec, slugify, SPEC_CHANNELS } from "./draft.js";
export { parseJson, parseYaml, stringifyJson, stringifyYaml } from "./documents.js";
export { formatQaError, ORCHESTRATION_ERROR_CODES, QaError } from "./errors.js";
export { prepareEnvironment, spawnApplication, stopProcessTree } from "./environment.js";
export { channelFor, createRunId, executeRun } from "./execution.js";
export {
  createReplayManifest,
  createReplayRecorder,
  executeWithReplay,
  renderRecordedReplay,
  renderReplayFromBindings,
  replayHash,
  replayPromotionSafe,
  replaySource,
  replayStatus,
  REPLAY_GENERATOR_VERSION,
  REPLAY_VALIDATION_RUNS,
  runReplayAttempt,
  validateReplayCandidate,
  validateReplayScriptSource,
} from "./replay.js";
export {
  buildDesignComparisonRequest,
  DEFAULT_DESIGN_VIEWPORT,
  DESIGN_COMPARISON_RULES,
  designConfigurationForSpec,
  normalizeDesignComparison,
  resolveDesignReference,
} from "./design.js";
export {
  classifyFailure,
  createExpectationGuard,
  normalizeRediscovery,
  normalizeTarget,
} from "./healing.js";
export {
  createNativeDesktopExecutor,
  createNativeWebExecutor,
  detectNativeCapability,
  NativeExecutor,
} from "./native-executor.js";
export { redactSensitive, resolveReference, resolveReferences } from "./references.js";
export { assertStableId, isStableId, validateDocument } from "./schema-validator.js";
export { atomicWriteFile, MAX_RECENT_RUNS_PER_SPEC, QaWorkspace } from "./storage.js";
export { createQaUiServer, startQaUi } from "./ui-server.js";
export { createTracer, traceEvent } from "./trace.js";
export { authDetailsFrom, bindLocators, mergeActionSteps, expectationPredicate, expectationProse, generate, inputCandidates, planToSpecs, predicateToPlaywright, renderAuthHelper, renderPlaywrightSpec, renderResolveHelper, validateSelectors } from "./generator.js";
export { buildReport, computeUntestedRisk, diffPrd, renderReportMarkdown, writeReport } from "./reporter.js";
export {
  authenticate,
  buildTestPlan,
  crawl,
  detectLoginForm,
  parseHtml,
  parsePrd,
  PROMPT_ALIASES,
  promptMatches,
  replan,
  renderTestPlanMarkdown,
  selectorCandidates,
  STRATEGY_ORDER,
} from "./planner.js";
export { COVERAGE_RULES, decideVerdict, evaluatePlan, renderGapsMarkdown, scorePlan } from "./coverage.js";
export { buildChain, resolveWithChain, triage } from "./locator-chain.js";
export { EXIT, assertTargetAllowed, orchestrate, planStages } from "./orchestrator.js";
export {
  buildPlannerBrief,
  normalizePlan,
  PLANNER_INSTRUCTIONS,
  planWithAgent,
  renderSiteMapBrief,
  reviewDraft,
} from "./planner-agent.js";
