#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const artifactDirectory = dirname(fileURLToPath(import.meta.url));
const voiceDirectory = join(artifactDirectory, "work", "voice");
const chapters = JSON.parse(readFileSync(join(artifactDirectory, "chapters.json"), "utf8"));
const voice = process.env.AUTO_QA_DEMO_VOICE ?? "en-US-BrianMultilingualNeural";

mkdirSync(voiceDirectory, { recursive: true });
for (const chapter of chapters) {
  const output = join(voiceDirectory, `${chapter.id}.mp3`);
  execFileSync("uvx", [
    "--from",
    "edge-tts",
    "edge-tts",
    "--voice",
    voice,
    "--rate=-2%",
    "--text",
    chapter.narration,
    "--write-media",
    output,
  ], { stdio: "inherit" });
  console.log(`Generated ${chapter.id}: ${chapter.title}`);
}

console.log(`Voice: ${voice}`);
