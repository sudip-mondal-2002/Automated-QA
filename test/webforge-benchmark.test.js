import assert from "node:assert/strict";
import test from "node:test";
import {
  assetIntegrity,
  evidenceMedia,
  expectedHash,
  findExternalUrls,
  gitBlobSha1,
  normalizeOperationCode,
  renderReport,
  sanitizeTask,
  selectTrack,
  sha256,
  summarize,
  validateTaskOrigin,
  verifyAsset,
  verifyLockedAsset,
} from "../benchmarks/web-agent/webforge/lib.mjs";

test("WebForge operation-code normalization is exact except for outer whitespace and Unicode form", () => {
  assert.equal(normalizeOperationCode("  Code-7 \n"), "Code-7");
  assert.equal(expectedHash("Code-7"), expectedHash(" Code-7 "));
  assert.notEqual(expectedHash("Code-7"), expectedHash("code-7"));
  assert.notEqual(expectedHash("A, B"), expectedHash("A,B"));
});

test("WebForge verifies regular Git blobs and LFS assets against pinned metadata", () => {
  const contents = Buffer.from("hello\n");
  const regular = { type: "file", path: "websites/a/index.html", size: contents.length, oid: gitBlobSha1(contents) };
  const lfs = {
    type: "file",
    path: "websites/a/image.png",
    size: contents.length,
    oid: "pointer-oid",
    lfs: { oid: sha256(contents), size: contents.length },
  };
  assert.deepEqual(assetIntegrity(regular), {
    algorithm: "git-blob-sha1",
    digest: regular.oid,
    size: contents.length,
  });
  assert.equal(verifyAsset(contents, regular), true);
  assert.equal(verifyAsset(Buffer.from("HELLO\n"), regular), false);
  assert.equal(verifyAsset(contents, lfs), true);
  assert.equal(verifyLockedAsset(contents, assetIntegrity(regular)), true);
  assert.equal(verifyLockedAsset(Buffer.from("bad"), assetIntegrity(regular)), false);
  assert.throws(() => assetIntegrity({ ...lfs, lfs: { ...lfs.lfs, size: 99 } }), /Invalid LFS metadata/);
});

test("WebForge recognizes screenshot bytes independently of misleading extensions", () => {
  assert.deepEqual(evidenceMedia(Buffer.from([0xff, 0xd8, 0xff, 0x00])), {
    extension: ".jpg",
    mimeType: "image/jpeg",
  });
  assert.throws(() => evidenceMedia(Buffer.from("not an image")), /PNG, JPEG, or WebP/);
});

test("WebForge task origins are isolated by task-specific localhost hostnames", () => {
  assert.equal(
    validateTaskOrigin("http://task-a.localhost:43123", "task-a"),
    "http://task-a.localhost:43123",
  );
  assert.throws(() => validateTaskOrigin("http://127.0.0.1:43123", "task-a"), /task-a\.localhost/);
  assert.throws(() => validateTaskOrigin("http://task-b.localhost:43123", "task-a"), /task-a\.localhost/);
  assert.throws(() => validateTaskOrigin("http://task-a.localhost:43123/path", "task-a"), /task-a\.localhost/);
});

test("WebForge offline scan catches direct, protocol-relative, and escaped external URLs", () => {
  assert.deepEqual(findExternalUrls('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), []);
  assert.deepEqual(findExternalUrls("fetch('https:\\/\\/example.com/data')"), ["https://example.com/data"]);
  assert.deepEqual(findExternalUrls("url(//cdn.example.com/font.woff2)"), ["//cdn.example.com/font.woff2"]);
});

test("WebForge track selection is deterministic and removes ground truth", () => {
  const tasks = [];
  for (let domain = 1; domain <= 7; domain += 1) {
    for (let level = 1; level <= 3; level += 1) {
      for (const suffix of ["a", "b"]) {
        tasks.push({
          id: `${domain}${level}${suffix}`,
          domain: `domain_${domain}`,
          level,
          answer_type: "operation_code",
          is_stochastic: false,
          ground_truth: `SECRET-${domain}-${level}-${suffix}`,
        });
      }
    }
  }
  const first = selectTrack(tasks);
  const second = selectTrack([...tasks].reverse());
  assert.equal(first.length, 21);
  assert.deepEqual(first.map((task) => task.id), second.map((task) => task.id));
  assert.equal("ground_truth" in sanitizeTask(first[0]), false);
  const withoutFirst = selectTrack(tasks, (task) => task.id !== first[0].id);
  assert.notEqual(withoutFirst[0].id, first[0].id);
});

test("WebForge scoring uses the fixed denominator and reports Wilson intervals", () => {
  const tasks = [
    { id: "a", domain: "domain_1", domain_name: "One", level: 1 },
    { id: "b", domain: "domain_2", domain_name: "Two", level: 2 },
  ];
  const summary = summarize([{ taskId: "a", correct: true, actions: 3, elapsedSeconds: 5 }], tasks);
  assert.equal(summary.correct, 1);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.accuracy, 0.5);
  assert.ok(summary.ci95.low < 0.5);
  assert.ok(summary.ci95.high > 0.5);
  const report = renderReport({
    ...summary,
    runId: "test-run",
    datasetRevision: "revision",
    assetCount: 2,
    assetBytes: 10,
  });
  assert.match(report, /runner-reported/);
  assert.match(report, /does not support inference/);
});
