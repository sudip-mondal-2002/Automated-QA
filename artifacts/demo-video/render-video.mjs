import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const artifactRoot = path.resolve(new URL(".", import.meta.url).pathname);
const framesRoot = path.join(artifactRoot, "frames");
const workRoot = path.join(artifactRoot, "work");
const timeline = JSON.parse(await readFile(path.join(artifactRoot, "timeline.json"), "utf8"));
const ffmpeg = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const ffprobe = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";
const voice = process.env.DEMO_VOICE || "Samantha";
const speechRate = process.env.DEMO_SPEECH_RATE || "185";
const frameRate = 30;

await mkdir(workRoot, { recursive: true });

function timestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

async function duration(file) {
  const { stdout } = await run(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(stdout.trim());
}

const rendered = [];
let cursor = 0;
let captions = "WEBVTT\n\n";

for (const scene of timeline) {
  const narrationFile = path.join(workRoot, `${scene.id}-narration.txt`);
  const labelFile = path.join(workRoot, `${scene.id}-label.txt`);
  const titleFile = path.join(workRoot, `${scene.id}-title.txt`);
  const audioFile = path.join(workRoot, `${scene.id}-voice.aiff`);
  const segmentFile = path.join(workRoot, `${scene.id}-segment.mp4`);
  await Promise.all([
    writeFile(narrationFile, `${scene.narration}\n`),
    writeFile(labelFile, `${scene.label}\n`),
    writeFile(titleFile, `${scene.title}\n`),
  ]);
  await run("/usr/bin/say", ["-v", voice, "-r", speechRate, "-f", narrationFile, "-o", audioFile]);
  const audioDuration = await duration(audioFile);
  const sceneDuration = Math.ceil((audioDuration + 0.65) * frameRate) / frameRate;
  const fadeOutStart = Math.max(0, sceneDuration - 0.22).toFixed(3);
  const filter = [
    `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xF4F6F8,`,
    `zoompan=z='min(zoom+0.00006,1.012)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=${frameRate},`,
    `drawbox=x=0:y=0:w=iw:h=86:color=0x101828@0.94:t=fill,`,
    `drawtext=font='Helvetica':textfile='${labelFile}':fontcolor=0x84ADFF:fontsize=17:x=34:y=15,`,
    `drawtext=font='Helvetica':textfile='${titleFile}':fontcolor=white:fontsize=28:x=34:y=43,`,
    `fade=t=in:st=0:d=0.18,fade=t=out:st=${fadeOutStart}:d=0.22,format=yuv420p[v];`,
    `[1:a]adelay=220|220,apad,atrim=duration=${sceneDuration.toFixed(3)},`,
    `afade=t=in:st=0.20:d=0.08,afade=t=out:st=${Math.max(0, sceneDuration - 0.28).toFixed(3)}:d=0.20[a]`,
  ].join("");
  await run(ffmpeg, [
    "-y",
    "-loop", "1",
    "-framerate", String(frameRate),
    "-i", path.join(framesRoot, scene.frame),
    "-i", audioFile,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "[a]",
    "-t", sceneDuration.toFixed(3),
    "-r", String(frameRate),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    segmentFile,
  ], { maxBuffer: 10 * 1024 * 1024 });

  rendered.push({
    ...scene,
    audioDuration,
    duration: sceneDuration,
    start: cursor,
    end: cursor + sceneDuration,
    segmentFile,
  });
  captions += `${scene.id}\n${timestamp(cursor + 0.22)} --> ${timestamp(cursor + Math.min(sceneDuration - 0.15, audioDuration + 0.22))}\n${scene.narration}\n\n`;
  cursor += sceneDuration;
}

const concatFile = path.join(workRoot, "segments.txt");
await writeFile(concatFile, rendered.map((scene) => `file '${scene.segmentFile.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
const finalVideo = path.join(artifactRoot, "auto-qa-full-demo.mp4");
await run(ffmpeg, [
  "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
  "-c", "copy", "-movflags", "+faststart", finalVideo,
], { maxBuffer: 10 * 1024 * 1024 });

const captionsFile = path.join(artifactRoot, "auto-qa-full-demo.vtt");
await writeFile(captionsFile, `${captions.trimEnd()}\n`);
const timingFile = path.join(artifactRoot, "timing-manifest.json");

const voiceoverFile = path.join(artifactRoot, "auto-qa-full-demo-voiceover.m4a");
await run(ffmpeg, ["-y", "-i", finalVideo, "-vn", "-c:a", "copy", voiceoverFile]);
const finalDuration = await duration(finalVideo);
const audioDuration = await duration(voiceoverFile);
if (Math.abs(finalDuration - cursor) > 0.08 || Math.abs(finalDuration - audioDuration) > 0.08) {
  throw new Error(`Timing validation failed: expected ${cursor}, video ${finalDuration}, audio ${audioDuration}`);
}
const { stdout: streamOutput } = await run(ffprobe, [
  "-v", "error",
  "-show_entries", "stream=codec_type,start_time,duration",
  "-of", "json",
  finalVideo,
]);
const streams = JSON.parse(streamOutput).streams;
const videoStream = streams.find((stream) => stream.codec_type === "video");
const audioStream = streams.find((stream) => stream.codec_type === "audio");
const videoEnd = Number(videoStream.start_time) + Number(videoStream.duration);
const audioEnd = Number(audioStream.start_time) + Number(audioStream.duration);
const avEndDelta = Math.abs(videoEnd - audioEnd);
if (avEndDelta > 0.008) {
  throw new Error(`A/V synchronization failed: video ends at ${videoEnd}, audio ends at ${audioEnd}`);
}
await writeFile(timingFile, `${JSON.stringify({
  voice,
  speechRate: Number(speechRate),
  frameRate,
  expectedDuration: cursor,
  finalDuration,
  audioDuration,
  videoEnd,
  audioEnd,
  avEndDelta,
  scenes: rendered.map(({ segmentFile, ...scene }) => scene),
}, null, 2)}\n`);

const contactSheet = path.join(artifactRoot, "contact-sheet.png");
await run(ffmpeg, [
  "-y", "-framerate", "1", "-pattern_type", "glob", "-i", path.join(framesRoot, "*.jpg"),
  "-vf", "scale=320:-1,tile=4x4:nb_frames=14:padding=4:margin=4:color=0x101828",
  "-frames:v", "1", contactSheet,
]);

const playbackContactSheet = path.join(artifactRoot, "playback-contact-sheet.png");
const midpointSelection = rendered
  .map((scene) => `eq(n,${Math.round(((scene.start + scene.end) / 2) * frameRate)})`)
  .join("+");
await run(ffmpeg, [
  "-y", "-i", finalVideo,
  "-vf", `select='${midpointSelection}',scale=320:-1,tile=4x4:nb_frames=14:padding=4:margin=4:color=0x101828`,
  "-frames:v", "1", playbackContactSheet,
]);

console.log(JSON.stringify({
  finalVideo,
  captionsFile,
  voiceoverFile,
  timingFile,
  contactSheet,
  playbackContactSheet,
  expectedDuration: cursor,
  finalDuration,
  audioDuration,
  videoEnd,
  audioEnd,
  avEndDelta,
  scenes: rendered.length,
}, null, 2));
