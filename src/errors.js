export class QaError extends Error {
  constructor(code, message, issues = [], options = {}) {
    super(message, options);
    this.name = "QaError";
    this.code = code;
    this.issues = issues;
  }
}

export function issue(path, message) {
  return { path, message };
}

export function formatQaError(error) {
  if (!(error instanceof QaError)) {
    return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const heading = `${error.message} [${error.code}]`;
  if (error.issues.length === 0) return heading;
  return `${heading}\n${error.issues.map(({ path, message }) => `  - ${path}: ${message}`).join("\n")}`;
}
