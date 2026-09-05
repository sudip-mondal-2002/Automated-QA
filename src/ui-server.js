import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyYaml } from "./documents.js";
import { QaError } from "./errors.js";
import { QaWorkspace } from "./storage.js";

const DEFAULT_UI_HOST = "127.0.0.1";
const DEFAULT_UI_PORT = 4173;
const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_ASSETS_DIRECTORY = fileURLToPath(new URL("../ui", import.meta.url));
const STATIC_ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

function uiError(code, message, issuePath = "$") {
  return new QaError(code, message, [{ path: issuePath, message }]);
}

function assertUiAddress(host, port) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw uiError("INVALID_UI_HOST", "The QA UI must bind to a loopback host", "$.host");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw uiError("INVALID_UI_PORT", "The QA UI port must be an integer from 0 to 65535", "$.port");
  }
}

function securityHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function send(response, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(status, { ...securityHeaders(contentType), ...headers });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

function statusForError(error) {
  if (!(error instanceof QaError)) return 500;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "METHOD_NOT_ALLOWED") return 405;
  if (error.code === "REQUEST_TOO_LARGE") return 413;
  if (new Set(["ID_MISMATCH", "SPEC_SELECTED", "FIXTURE_IN_USE"]).has(error.code)) return 409;
  return 422;
}

function sendError(response, error) {
  const known = error instanceof QaError;
  sendJson(response, statusForError(error), {
    error: {
      code: known ? error.code : "UNEXPECTED_ERROR",
      message: known ? error.message : "The QA UI could not complete the request",
      issues: known ? error.issues : [],
    },
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw uiError("REQUEST_TOO_LARGE", "Request body exceeds the 1 MB UI limit", "$.body");
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("object required");
    return value;
  } catch (error) {
    throw new QaError("INVALID_REQUEST_JSON", "Request body must be a JSON object", [
      { path: "$.body", message: "provide a valid JSON object" },
    ], { cause: error });
  }
}

function routeParts(pathname) {
  try {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch (error) {
    throw new QaError("INVALID_ROUTE", "Request path is not valid URL encoding", [], { cause: error });
  }
}

function documentOperations(workspace, collection) {
  if (collection === "specs") {
    return {
      kind: "spec",
      load: (id) => workspace.loadSpec(id),
      validate: (yaml) => workspace.validateSpec(yaml, "Spec YAML from UI"),
      save: (yaml) => workspace.saveSpec(yaml),
      filePath: (id) => workspace.specPath(id),
    };
  }
  if (collection === "fixtures") {
    return {
      kind: "fixture",
      load: (id) => workspace.loadFixture(id),
      validate: (yaml) => workspace.validateFixture(yaml, "Fixture YAML from UI"),
      save: (yaml) => workspace.saveFixture(yaml),
      filePath: (id) => workspace.fixturePath(id),
    };
  }
  throw uiError("UNKNOWN_DOCUMENT_KIND", `Unknown document collection: ${collection}`, "$.kind");
}

function assertDocumentId(value, expectedId) {
  if (expectedId !== undefined && value.id !== expectedId) {
    throw new QaError("ID_MISMATCH", `Document ID must remain ${expectedId}`, [
      { path: "$.id", message: `expected ${expectedId}` },
    ]);
  }
}

async function selectedTest(workspace) {
  try {
    return await workspace.readLastTest();
  } catch (error) {
    if (error instanceof QaError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

async function workspaceSummary(workspace) {
  const [specs, fixtures, environments, results, selected] = await Promise.all([
    workspace.listSpecs(),
    workspace.listFixtures(),
    workspace.listEnvironments(),
    workspace.listResults({ limit: 50 }),
    selectedTest(workspace),
  ]);
  const latestBySpec = new Map();
  for (const result of results) {
    if (!latestBySpec.has(result.specId)) latestBySpec.set(result.specId, result);
  }
  const tests = specs.map((spec) => {
    const lastRun = latestBySpec.get(spec.id);
    const environment = lastRun?.environment
      ?? (selected?.specId === spec.id ? selected.environment : spec.environment);
    return {
      id: spec.id,
      title: spec.title,
      environment: spec.environment,
      lastEnvironment: environment,
      lastStatus: lastRun?.classification ?? "not_run",
      lastRunId: lastRun?.runId,
      runPrompt: `$autonomous-qa Run ${spec.id} on ${environment} through the native UI capability and save the result and evidence.`,
    };
  });
  return {
    tests,
    fixtures: fixtures.map(({ id, title }) => ({ id, title })),
    environments,
    selected,
    rerunPrompt: "$autonomous-qa Rerun the last selected test with its saved environment and keep every expectation unchanged.",
    recentRuns: results.map((result) => ({
      runId: result.runId,
      specId: result.specId,
      environment: result.environment,
      classification: result.classification,
      completedAt: result.completedAt,
      explanation: result.explanation ?? "No explanation was recorded.",
      screenshotCount: result.evidence?.screenshots?.length ?? 0,
    })),
  };
}

function screenshotContentType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

async function serveStatic(response, pathname, assetsDirectory) {
  const asset = STATIC_ASSETS.get(pathname);
  if (!asset) return false;
  const contents = await readFile(path.join(assetsDirectory, asset.file));
  send(response, 200, contents, asset.type);
  return true;
}

export function createQaUiServer({
  workspace = new QaWorkspace(),
  assetsDirectory = DEFAULT_ASSETS_DIRECTORY,
} = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const parts = routeParts(url.pathname);

      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ready" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/workspace") {
        sendJson(response, 200, await workspaceSummary(workspace));
        return;
      }
      if (parts[0] === "api" && parts[1] === "documents" && parts.length === 4) {
        const operations = documentOperations(workspace, parts[2]);
        if (parts[3] === "validate" && request.method === "POST") {
          const body = await readJsonBody(request);
          const value = await operations.validate(body.yaml);
          assertDocumentId(value, body.id);
          sendJson(response, 200, { valid: true, document: value });
          return;
        }
        const id = parts[3];
        if (request.method === "GET") {
          const value = await operations.load(id);
          const yaml = await readFile(operations.filePath(id), "utf8");
          sendJson(response, 200, { kind: operations.kind, id, title: value.title, yaml });
          return;
        }
        if (request.method === "PUT") {
          const body = await readJsonBody(request);
          const value = await operations.validate(body.yaml);
          assertDocumentId(value, id);
          const saved = await operations.save(body.yaml);
          sendJson(response, 200, {
            saved: true,
            document: { kind: operations.kind, id, title: saved.title, yaml: stringifyYaml(saved) },
          });
          return;
        }
        throw uiError("METHOD_NOT_ALLOWED", "Document endpoint supports GET or PUT", "$.method");
      }
      if (parts[0] === "api" && parts[1] === "runs" && parts.length === 3) {
        const runId = parts[2];
        if (request.method === "GET") {
          sendJson(response, 200, { result: await workspace.loadResult(runId) });
          return;
        }
        if (request.method === "DELETE") {
          const deleted = await workspace.deleteResult(runId);
          sendJson(response, 200, { deleted: true, runId: deleted.runId });
          return;
        }
        throw uiError("METHOD_NOT_ALLOWED", "Run endpoint supports GET or DELETE", "$.method");
      }
      if (
        request.method === "GET"
        && parts[0] === "api"
        && parts[1] === "runs"
        && parts[3] === "screenshots"
        && parts.length === 5
      ) {
        const [, , runId, , fileName] = parts;
        const result = await workspace.loadResult(runId);
        const relativePath = path.posix.join("screenshots", fileName);
        if (!(result.evidence?.screenshots ?? []).includes(relativePath)) {
          throw new QaError("NOT_FOUND", "Screenshot is not part of this run's evidence");
        }
        const contents = await readFile(workspace.screenshotPath(runId, fileName));
        send(response, 200, contents, screenshotContentType(fileName));
        return;
      }
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "orchestrations" && parts.length >= 3) {
        const { readFile: readTrace } = await import("node:fs/promises");
        const orchId = parts[2];
        const since = Number(url.searchParams.get("since") ?? 0);
        try {
          const raw = await readTrace(path.join(workspace.qaDirectory, "runs", "orchestrations", orchId, "trace.jsonl"), "utf8");
          const lines = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => (entry.seq ?? 0) > since);
          const { redactSensitive } = await import("./references.js");
          sendJson(response, 200, { orchestrationId: orchId, events: lines.map((entry) => redactSensitive(entry, [])) });
        } catch {
          sendJson(response, 200, { orchestrationId: orchId, events: [] });
        }
        return;
      }
      if (request.method === "GET" && await serveStatic(response, url.pathname, assetsDirectory)) return;
      throw new QaError("NOT_FOUND", `UI route does not exist: ${url.pathname}`);
    } catch (error) {
      sendError(response, error);
    }
  });

  return {
    server,
    async start({ host = DEFAULT_UI_HOST, port = DEFAULT_UI_PORT } = {}) {
      assertUiAddress(host, port);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      const visibleHost = host === "::1" ? "[::1]" : host;
      return `http://${visibleHost}:${address.port}`;
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function startQaUi(options = {}) {
  const application = createQaUiServer(options);
  const url = await application.start({ host: options.host, port: options.port });
  return { ...application, url };
}
