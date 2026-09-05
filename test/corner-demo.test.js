import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCornerCaseMatrix } from "../scripts/demo-corner-cases.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "demo-corner-cases.mjs");

test("corner demo stays in sync with all 28 documented contracts and live mutations", () => {
  const matrix = buildCornerCaseMatrix();
  assert.equal(matrix.length, 28);
  assert.deepEqual(
    Object.fromEntries(["Planner", "Healing", "Design", "Executor"].map((area) => [
      area,
      matrix.filter((item) => item.area === area).length,
    ])),
    { Planner: 10, Healing: 8, Design: 4, Executor: 6 },
  );
  assert(matrix.every((item) => item.evidence.length > 0));
  assert.deepEqual(
    matrix.filter((item) => item.liveScenarios.length > 0).map((item) => item.id),
    ["H1", "H2", "H3", "H4", "H7", "D1", "D4", "E5"],
  );
});

test("corner demo CLI can list the matrix and verify one selected case", () => {
  const listed = spawnSync(process.execPath, [script, "--list", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  const listPayload = JSON.parse(listed.stdout);
  assert.equal(listPayload.count, 28);
  assert.equal(listPayload.verified, null);

  const verified = spawnSync(process.execPath, [script, "--case", "H7", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  const verifyPayload = JSON.parse(verified.stdout);
  assert.equal(verifyPayload.count, 1);
  assert.equal(verifyPayload.verified, true);
  assert.equal(verifyPayload.cases[0].id, "H7");
  assert.equal(verifyPayload.cases[0].verified, true);
  assert.equal(verifyPayload.cases[0].liveScenarios[0].scenario, "drift-functional");
});
