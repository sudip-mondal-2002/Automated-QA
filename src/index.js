export { draftSpec, slugify } from "./draft.js";
export { parseJson, parseYaml, stringifyJson, stringifyYaml } from "./documents.js";
export { formatQaError, QaError } from "./errors.js";
export { prepareEnvironment, spawnApplication } from "./environment.js";
export { createRunId, executeRun } from "./execution.js";
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
export { atomicWriteFile, QaWorkspace } from "./storage.js";
