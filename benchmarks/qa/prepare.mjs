#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  DIMENSIONS,
  GENERATION_SEED,
  HEALING_IDS,
  REGRESSION_SEED,
  TRACK_ID,
  createPreparedTrack,
  parseCsv,
  sha256,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEFAULT_CACHE_DIR = resolve(ROOT, ".benchmark-cache/qa");

const SOURCES = {
  webtestbench: {
    filename: "sources/WebTestBench.json",
    url: "https://huggingface.co/datasets/friedrichor/WebTestBench/resolve/2feeec346c71f7adb30dff9c64e185bb4cdfc0fe/WebTestBench.json",
    sha256: "5b9a2f11a4e224ba714258f98424ae2a40e634e5446b08c903a231ed346402f2",
  },
  reprobreak: {
    filename: "sources/reprobreak-locator-analysis.csv",
    url: "https://raw.githubusercontent.com/rub-sq/ReproBreak/c603a0ccc980c552d9ca3c05c031e36a094ef5df/locator_analysis.csv",
    sha256: "2233e024879a4ce92e287022b12d4f71af7140b5ec882ca81e1423c7697d1201",
  },
};

function parseArgs(argv) {
  const options = { cacheDir: DEFAULT_CACHE_DIR, refresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--refresh") {
      options.refresh = true;
    } else if (argument === "--cache-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--cache-dir requires a path");
      options.cacheDir = resolve(value);
      index += 1;
    } else if (argument === "--help") {
      console.log("Usage: node benchmarks/qa/prepare.mjs [--refresh] [--cache-dir PATH]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

async function lockedSource(cacheDir, source, refresh) {
  const path = resolve(cacheDir, source.filename);
  if (!refresh) {
    try {
      const cached = await readFile(path);
      const actual = sha256(cached);
      if (actual !== source.sha256) {
        throw new Error(`Cached source failed SHA-256 verification: ${path}\nexpected ${source.sha256}\nactual   ${actual}\nRun again with --refresh to replace it.`);
      }
      return cached;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to download ${source.url}: HTTP ${response.status}`);
  const contents = Buffer.from(await response.arrayBuffer());
  const actual = sha256(contents);
  if (actual !== source.sha256) {
    throw new Error(`Downloaded source failed SHA-256 verification: ${source.url}\nexpected ${source.sha256}\nactual   ${actual}`);
  }
  await atomicWrite(path, contents);
  return contents;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writePreparedFiles(cacheDir, prepared) {
  const outputs = {
    "candidate/generation.json": json({ trackId: TRACK_ID, cases: prepared.candidates.generation }),
    "candidate/regression.json": json({ trackId: TRACK_ID, cases: prepared.candidates.regression }),
    "candidate/healing.json": json({ trackId: TRACK_ID, cases: prepared.candidates.healing }),
    "reference/generation.json": json({ trackId: TRACK_ID, cases: prepared.references.generation }),
    "reference/regression.json": json({ trackId: TRACK_ID, cases: prepared.references.regression }),
    "reference/healing.json": json({ trackId: TRACK_ID, cases: prepared.references.healing }),
  };
  for (const [relativePath, contents] of Object.entries(outputs)) {
    await atomicWrite(resolve(cacheDir, relativePath), contents);
  }

  const manifest = {
    schemaVersion: 1,
    trackId: TRACK_ID,
    selection: {
      generation: { seed: GENERATION_SEED, categories: CATEGORIES, perCategory: 2 },
      regression: {
        seed: REGRESSION_SEED,
        categories: CATEGORIES,
        dimensions: DIMENSIONS,
        outcomesPerCell: ["Pass", "Fail"],
      },
      healing: { locatorIds: HEALING_IDS },
    },
    counts: {
      generation: prepared.candidates.generation.length,
      regression: prepared.candidates.regression.length,
      healing: prepared.candidates.healing.length,
    },
    files: Object.fromEntries(Object.entries(outputs).map(([path, contents]) => [path, {
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    }])),
  };
  await atomicWrite(resolve(cacheDir, "manifest.json"), json(manifest));
  return manifest;
}

async function assertFrozenInventory(prepared) {
  const frozen = JSON.parse(await readFile(resolve(HERE, "track.json"), "utf8"));
  for (const lane of ["generation", "regression", "healing"]) {
    const ids = prepared.candidates[lane].map((item) => item.id);
    const digest = sha256(`${ids.join("\n")}\n`);
    const expected = frozen.lanes?.[lane]?.caseIdsSha256;
    if (digest !== expected || ids.length !== frozen.lanes?.[lane]?.caseCount) {
      throw new Error(`Prepared ${lane} inventory does not match the checked-in frozen track`);
    }
    const referenceDigest = sha256(json({ trackId: TRACK_ID, cases: prepared.references[lane] }));
    if (referenceDigest !== frozen.lanes?.[lane]?.referenceSha256) {
      throw new Error(`Prepared ${lane} reference contents do not match the checked-in frozen track`);
    }
    const candidateDigest = sha256(json({ trackId: TRACK_ID, cases: prepared.candidates[lane] }));
    if (candidateDigest !== frozen.lanes?.[lane]?.candidateSha256) {
      throw new Error(`Prepared ${lane} candidate contents do not match the checked-in frozen track`);
    }
  }
  const archiveManifestBytes = await readFile(resolve(HERE, "webtestbench-app-archives.json"));
  if (sha256(archiveManifestBytes) !== frozen.lanes?.regression?.appArchiveManifestSha256) {
    throw new Error("WebTestBench runnable-archive manifest does not match the frozen track");
  }
  const archiveManifest = JSON.parse(archiveManifestBytes);
  const expectedApps = [...new Set(prepared.candidates.regression.map((item) => item.appId))].sort();
  const actualApps = archiveManifest.apps?.map((item) => item.appId).sort() ?? [];
  if (archiveManifest.datasetRevision !== "2feeec346c71f7adb30dff9c64e185bb4cdfc0fe"
    || JSON.stringify(actualApps) !== JSON.stringify(expectedApps)
    || new Set(actualApps).size !== actualApps.length
    || archiveManifest.apps.some((item) => !/^[a-f0-9]{64}$/.test(item.sha256) || !(item.bytes > 0))) {
    throw new Error("WebTestBench runnable-archive manifest does not cover the frozen regression apps");
  }
}

async function main() {
  const { cacheDir, refresh } = parseArgs(process.argv.slice(2));
  const [webtestbenchBytes, reprobreakBytes] = await Promise.all([
    lockedSource(cacheDir, SOURCES.webtestbench, refresh),
    lockedSource(cacheDir, SOURCES.reprobreak, refresh),
  ]);
  const webtestbench = JSON.parse(webtestbenchBytes.toString("utf8"));
  const reprobreak = parseCsv(reprobreakBytes.toString("utf8"));
  const prepared = createPreparedTrack(webtestbench, reprobreak);
  await assertFrozenInventory(prepared);
  const manifest = await writePreparedFiles(cacheDir, prepared);
  console.log(`Prepared ${manifest.trackId} in ${cacheDir}`);
  console.log(`Generation: ${manifest.counts.generation}; regression: ${manifest.counts.regression}; healing: ${manifest.counts.healing}`);
  console.log("Candidate views contain no pass/bug labels or replacement locators; keep reference/ evaluator-only.");
}

await main();
