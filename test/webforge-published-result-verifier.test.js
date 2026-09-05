import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TRACK_ID,
  sha256,
  summarize,
} from "../benchmarks/web-agent/webforge/lib.mjs";
import { verifyPublishedResult } from "../benchmarks/web-agent/webforge/verify.mjs";

const RUN_ID = "synthetic-run";
const TASK_ID = "task-a";
const REVISION = "1".repeat(40);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=",
  "base64",
);

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "auto-qa-webforge-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const benchmarkDir = join(root, "benchmark");
  const resultDir = join(root, "result");
  const evidenceDir = join(resultDir, "evidence");
  const evidencePath = join(evidenceDir, `${TASK_ID}.png`);
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, PNG);

  const expectedAnswerHash = sha256("EXPECTED-CODE");
  const expectedHashes = { [TASK_ID]: expectedAnswerHash };
  const expectedContents = `${JSON.stringify(expectedHashes, null, 2)}\n`;
  const expectedHashesPath = join(resultDir, "expected-answer-hashes.json");
  await writeFile(expectedHashesPath, expectedContents);

  const aggregate = summarize(
    [{
      taskId: TASK_ID,
      correct: true,
      actions: 3,
      elapsedSeconds: 4,
      evidence: true,
    }],
    [{
      id: TASK_ID,
      domain: "domain_1",
      domain_name: "Synthetic",
      level: 1,
    }],
  );
  const summary = {
    ...aggregate,
    cases: aggregate.cases.map((row) => ({
      ...row,
      submittedAnswerSha256: expectedAnswerHash,
    })),
    trackDisclosure: { status: "retired-disclosed" },
    scoringAudit: {
      expectedHashesFile: "expected-answer-hashes.json",
      expectedHashesFileSha256: sha256(expectedContents),
    },
    evidence: [{
      taskId: TASK_ID,
      file: `evidence/${TASK_ID}.png`,
      mimeType: "image/png",
      sha256: sha256(PNG),
      bytes: PNG.length,
    }],
    executionProtocolRevision: REVISION,
    publisherRevision: REVISION,
  };
  const summaryPath = join(resultDir, "summary.json");
  await writeJson(summaryPath, summary);
  await writeJson(join(benchmarkDir, "track.json"), {
    version: 1,
    track: TRACK_ID,
    status: "retired-disclosed",
    taskIds: [TASK_ID],
    answerHashesSha256: sha256(expectedContents),
  });

  async function mutateSummary(mutator) {
    const value = JSON.parse(await readFile(summaryPath, "utf8"));
    mutator(value);
    await writeJson(summaryPath, value);
  }

  return {
    benchmarkDir,
    evidenceDir,
    evidencePath,
    expectedHashesPath,
    resultDir,
    mutateSummary,
  };
}

function verify(fixture) {
  return verifyPublishedResult(RUN_ID, {
    benchmarkDir: fixture.benchmarkDir,
    resultDir: fixture.resultDir,
  });
}

test("published WebForge verifier accepts a valid self-contained result", async (t) => {
  const fixture = await createFixture(t);
  assert.deepEqual(await verify(fixture), {
    runId: RUN_ID,
    correct: 1,
    total: 1,
    accuracy: 1,
    evidence: 1,
  });
});

test("published WebForge verifier rejects a tampered submitted-answer hash", async (t) => {
  const fixture = await createFixture(t);
  await fixture.mutateSummary((summary) => {
    summary.cases[0].submittedAnswerSha256 = sha256("WRONG-CODE");
  });
  await assert.rejects(verify(fixture), /Published correctness metadata mismatch/);
});

test("published WebForge verifier rejects tampered correctness metadata", async (t) => {
  const fixture = await createFixture(t);
  await fixture.mutateSummary((summary) => {
    summary.cases[0].correct = false;
  });
  await assert.rejects(verify(fixture), /Published correctness metadata mismatch/);
});

test("published WebForge verifier rejects a broken expected-hash commitment", async (t) => {
  const fixture = await createFixture(t);
  await writeJson(fixture.expectedHashesPath, { [TASK_ID]: sha256("OTHER-CODE") });
  await assert.rejects(verify(fixture), /expected-answer hashes do not match the frozen commitment/);
});

test("published WebForge verifier rejects tampered evidence bytes", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.evidencePath, Buffer.concat([PNG, Buffer.from([0])]));
  await assert.rejects(verify(fixture), /Published evidence metadata mismatch/);
});

test("published WebForge verifier rejects tampered evidence metadata", async (t) => {
  const fixture = await createFixture(t);
  await fixture.mutateSummary((summary) => {
    summary.evidence[0].sha256 = "0".repeat(64);
  });
  await assert.rejects(verify(fixture), /Published evidence metadata mismatch/);
});

test("published WebForge verifier rejects evidence symlinks escaping the evidence root", async (t) => {
  const fixture = await createFixture(t);
  const outside = join(fixture.resultDir, "outside.png");
  await writeFile(outside, PNG);
  await unlink(fixture.evidencePath);
  try {
    await symlink(outside, fixture.evidencePath);
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(verify(fixture), /Invalid evidence path/);
});
