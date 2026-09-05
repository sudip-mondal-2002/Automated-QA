import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_CACHE_DIR, assertSafeId, parseArgs, verifyLockedAsset } from "./lib.mjs";
import { loadVerifiedCache } from "./protocol.mjs";

const TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const args = parseArgs(process.argv.slice(2));
const taskId = assertSafeId(args.task, "task id");
const port = Number(args.port ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${args.port}`);
const cacheDir = resolve(args.cache ?? DEFAULT_CACHE_DIR);
const { selection, assetLock } = await loadVerifiedCache(cacheDir);
const task = selection.tasks.find((entry) => entry.id === taskId);
if (!task) throw new Error(`Task ${taskId} is outside the pinned track`);
const siteRoot = resolve(cacheDir, "websites", taskId);
const taskPrefix = `/${taskId}`;
const taskHostname = `${taskId}.localhost`;
const lockedFiles = assetLock.files.filter((entry) => entry.path.startsWith(`websites/${taskId}/`));
if (lockedFiles.length === 0) throw new Error(`Pinned asset inventory is empty for ${taskId}`);
for (const lock of lockedFiles) {
  const path = resolve(cacheDir, lock.path);
  const inside = relative(siteRoot, path);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Unsafe pinned asset path: ${lock.path}`);
  const contents = await readFile(path);
  if (!verifyLockedAsset(contents, lock)) throw new Error(`Pinned asset checksum mismatch: ${lock.path}`);
}

const server = createServer((request, response) => {
  let requestHostname;
  try {
    requestHostname = new URL(`http://${request.headers.host}`).hostname;
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (requestHostname !== taskHostname) {
    response.writeHead(421).end("Use the task-specific localhost origin");
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const withoutTaskPrefix = pathname === taskPrefix
    ? "/"
    : pathname.startsWith(`${taskPrefix}/`)
      ? pathname.slice(taskPrefix.length)
      : pathname;
  const requested = withoutTaskPrefix === "/" ? "/index.html" : withoutTaskPrefix;
  const path = resolve(siteRoot, `.${requested}`);
  const inside = relative(siteRoot, path);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  const stream = createReadStream(path);
  stream.on("error", (error) => {
    console.error(`WEBFORGE_ASSET_ERROR=${error.code ?? "UNKNOWN"} ${pathname}`);
    response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
  });
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'self' data: blob:; object-src 'none'; base-uri 'self'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Type", TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream");
  stream.pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const origin = `http://${taskHostname}:${address.port}`;
  console.log(`WEBFORGE_TASK=${taskId}`);
  console.log(`WEBFORGE_ORIGIN=${origin}`);
  console.log(`WEBFORGE_URL=${origin}${task.url}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
