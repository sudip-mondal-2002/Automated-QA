import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repositoryRoot, ".agents", "skills", "autonomous-qa");

await mkdir(path.join(skillRoot, "runtime"), { recursive: true });
await build({
  entryPoints: [path.join(repositoryRoot, "src", "skill-runtime.js")],
  outfile: path.join(skillRoot, "runtime", "qa-agent.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  sourcemap: false,
  legalComments: "none",
});

await Promise.all([
  cp(path.join(repositoryRoot, "schemas"), path.join(skillRoot, "schemas"), {
    recursive: true,
    force: true,
  }),
  cp(path.join(repositoryRoot, "ui"), path.join(skillRoot, "ui"), {
    recursive: true,
    force: true,
  }),
]);
