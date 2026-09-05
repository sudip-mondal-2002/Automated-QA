import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repositoryRoot, ".agents", "skills", "autonomous-qa");
const playwrightSupport = path.join(skillRoot, "runtime", "playwright-core");
const runtimeOutput = path.join(skillRoot, "runtime", "qa-agent.mjs");

await mkdir(path.join(skillRoot, "runtime"), { recursive: true });
await mkdir(playwrightSupport, { recursive: true });
await build({
  entryPoints: [path.join(repositoryRoot, "src", "skill-runtime.js")],
  outfile: runtimeOutput,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minifyWhitespace: true,
  banner: {
    // Playwright's prebuilt CommonJS bundles resolve two data files relative
    // to their package root. Point that lookup at the tiny metadata directory
    // shipped beside this single-file bundle.
    js: [
      'import { createRequire } from "node:module";',
      'import { fileURLToPath as __qaFileURLToPath } from "node:url";',
      'import { dirname as __qaDirname, join as __qaJoin } from "node:path";',
      'const require = createRequire(import.meta.url);',
      'const __filename = __qaFileURLToPath(import.meta.url);',
      'const __dirname = __qaJoin(__qaDirname(__filename), "playwright-core", "lib");',
    ].join(" "),
  },
  sourcemap: false,
  legalComments: "eof",
  plugins: [{
    name: "playwright-replay-runtime",
    setup(context) {
      // Replays need Playwright's web-first expect API, not its test runner,
      // reporters, transpiler, or CLI. Bundle the matcher entry directly so
      // those unrelated development modules never enter the skill artifact.
      context.onResolve({ filter: /^@playwright\/test$/ }, () => ({
        path: path.join(repositoryRoot, "node_modules", "playwright", "lib", "matchers", "expect.js"),
      }));
    },
  }],
  external: [
    // These modules are used only by Playwright's optional WebDriver BiDi
    // bridge. Trusted replays launch installed Chrome/Edge through CDP.
    "chromium-bidi/lib/cjs/bidiMapper/BidiMapper",
    "chromium-bidi/lib/cjs/cdp/CdpConnection",
    // The test runner's file watcher can use this optional native module, but
    // the replay runtime never starts the watcher.
    "fsevents",
  ],
});
// Keep the checked-in generated artifact friendly to Git's whitespace check.
await writeFile(runtimeOutput, (await readFile(runtimeOutput, "utf8")).replace(/[\t ]+$/gm, ""));

await Promise.all([
  cp(path.join(repositoryRoot, "schemas"), path.join(skillRoot, "schemas"), {
    recursive: true,
    force: true,
  }),
  cp(path.join(repositoryRoot, "ui"), path.join(skillRoot, "ui"), {
    recursive: true,
    force: true,
  }),
  cp(path.join(repositoryRoot, "node_modules", "playwright-core", "package.json"), path.join(playwrightSupport, "package.json"), { force: true }),
  cp(path.join(repositoryRoot, "node_modules", "playwright-core", "browsers.json"), path.join(playwrightSupport, "browsers.json"), { force: true }),
]);
