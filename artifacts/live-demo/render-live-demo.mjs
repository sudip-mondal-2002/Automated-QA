#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifactDirectory = dirname(fileURLToPath(import.meta.url));
const workDirectory = join(artifactDirectory, "work");
const generatedDirectory = join(workDirectory, "generated");
const chapters = JSON.parse(readFileSync(join(artifactDirectory, "chapters.json"), "utf8"));
const font = "/System/Library/Fonts/Supplemental/Arial.ttf";
const leadIn = 0.2;
const tail = 0.45;

const screenshots = {
  "01": [
    "02-skill-install.png",
    "03-developer-prompt.png",
    "03-workspace-overview.png",
  ],
  "03": [
    "03-developer-prompt.png",
    "03-create-terminal-check.png",
    "03-workspace-overview.png",
  ],
  "04": [
    "04-pass-01-dashboard.png",
    "04-pass-02-cart.png",
    "04-pass-03-checkout.png",
    "04-pass-04-confirmed.png",
    "04-pass-05-evidence.png",
  ],
  "05": [
    "05-heal-01-drift-cart.png",
    "05-heal-02-options.png",
    "05-heal-03-checkout.png",
    "05-heal-04-confirmed.png",
    "05-heal-05-evidence.png",
  ],
  "06": [
    "06-functional-01-checkout.png",
    "06-functional-02-error.png",
    "06-functional-03-evidence.png",
  ],
  "07": [
    "07-design-01-checkout.png",
    "07-design-02-mismatch.png",
    "07-design-03-evidence.png",
  ],
};

const commandCallouts = {
  "02": "$skill-installer Install the autonomous-qa GitHub skill",
  "03": "$autonomous-qa Set up QA, run checkout, and show evidence",
  "04": "The skill starts the app · native Browser drives the journey",
  "05": "$autonomous-qa Rerun last · expectations stay unchanged",
  "06": "Same rerun prompt · required outcome fails · no healing",
  "07": "$autonomous-qa Run the explicit-reference design check",
  "08": "Application files + reviewable .qa evidence · no QA dependency",
};

function run(program, args, options = {}) {
  const quietArgs = program === "ffmpeg" ? ["-hide_banner", "-loglevel", "warning", ...args] : args;
  execFileSync(program, quietArgs, { stdio: "inherit", ...options });
}

function probeDuration(path) {
  return Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      path,
    ], { encoding: "utf8" }).trim(),
  );
}

function probeStreamDurations(path) {
  const value = JSON.parse(execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,duration",
    "-of",
    "json",
    path,
  ], { encoding: "utf8" }));
  return Object.fromEntries(value.streams.map((stream) => [stream.codec_type, Number(stream.duration)]));
}

function probeDecodedAudioDuration(path) {
  const sampleRate = Number(execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=sample_rate",
    "-of",
    "default=nw=1:nk=1",
    path,
  ], { encoding: "utf8" }).trim());
  const samples = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "frame=nb_samples",
    "-of",
    "csv=p=0",
    path,
  ], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce((sum, value) => sum + Number(value), 0);
  return samples / sampleRate;
}

function seconds(value) {
  return Number(value.toFixed(6));
}

function makeStillClip(image, output, duration) {
  run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-t",
    String(duration),
    "-i",
    image,
    "-vf",
    "scale=1960:1103,crop=1920:1080,zoompan=z='min(zoom+0.00022,1.025)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,setsar=1,format=yuv420p",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    output,
  ]);
}

function makeScreenshotSequence(chapterId, images, output, duration) {
  const transition = 0.55;
  const clipDuration = (duration + (images.length - 1) * transition) / images.length;
  const clips = images.map((image, index) => {
    const outputPath = join(generatedDirectory, `${chapterId}-frame-${index + 1}.mp4`);
    makeStillClip(join(workDirectory, image), outputPath, clipDuration);
    return outputPath;
  });

  if (clips.length === 1) {
    run("ffmpeg", ["-y", "-i", clips[0], "-t", String(duration), "-c", "copy", output]);
    return;
  }

  const args = ["-y"];
  for (const clip of clips) args.push("-i", clip);
  let filter = "";
  let previous = "0:v";
  for (let index = 1; index < clips.length; index += 1) {
    const label = `mix${index}`;
    const offset = seconds(index * (clipDuration - transition));
    filter += `[${previous}][${index}:v]xfade=transition=fade:duration=${transition}:offset=${offset}[${label}];`;
    previous = label;
  }
  args.push(
    "-filter_complex",
    filter.slice(0, -1),
    "-map",
    `[${previous}]`,
    "-t",
    String(duration),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    output,
  );
  run("ffmpeg", args);
}

function makeRecordedClip(input, output, duration) {
  const sourceDuration = probeDuration(input);
  const hold = Math.max(0, duration - sourceDuration);
  const filter = [
    "fps=30",
    "scale=1920:1080:force_original_aspect_ratio=decrease",
    "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b1020",
    "setsar=1",
    ...(hold > 0 ? [`tpad=stop_mode=clone:stop_duration=${seconds(hold)}`] : []),
    "format=yuv420p",
  ].join(",");
  run("ffmpeg", [
    "-y",
    "-i",
    input,
    "-vf",
    filter,
    "-t",
    String(duration),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    output,
  ]);
}

function makeCreationClip(output, duration) {
  const terminalDuration = Math.min(18, duration * 0.68);
  const transition = 0.55;
  const terminal = join(generatedDirectory, "03-terminal.mp4");
  const yaml = join(generatedDirectory, "03-yaml.mp4");
  makeRecordedClip(join(workDirectory, "03-create-terminal.mov"), terminal, terminalDuration);
  makeStillClip(
    join(workDirectory, "03-create-ui-yaml.png"),
    yaml,
    duration - terminalDuration + transition,
  );
  run("ffmpeg", [
    "-y",
    "-i",
    terminal,
    "-i",
    yaml,
    "-filter_complex",
    `[0:v][1:v]xfade=transition=fade:duration=${transition}:offset=${seconds(terminalDuration - transition)}[v]`,
    "-map",
    "[v]",
    "-t",
    String(duration),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    output,
  ]);
}

function makeHybridClip(chapterId, image, recording, output, duration, stillRatio = 0.46) {
  const transition = 0.55;
  const stillDuration = Math.max(7, duration * stillRatio);
  const still = join(generatedDirectory, `${chapterId}-still.mp4`);
  const motion = join(generatedDirectory, `${chapterId}-motion.mp4`);
  makeStillClip(join(workDirectory, image), still, stillDuration);
  makeRecordedClip(
    join(workDirectory, recording),
    motion,
    duration - stillDuration + transition,
  );
  run("ffmpeg", [
    "-y",
    "-i",
    still,
    "-i",
    motion,
    "-filter_complex",
    `[0:v][1:v]xfade=transition=fade:duration=${transition}:offset=${seconds(stillDuration - transition)}[v]`,
    "-map",
    "[v]",
    "-t",
    String(duration),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    output,
  ]);
}

function overlayChapter(base, chapter, output, duration) {
  const titlePath = join(generatedDirectory, `${chapter.id}-title.txt`);
  const commandPath = join(generatedDirectory, `${chapter.id}-command.txt`);
  writeFileSync(titlePath, `${chapter.id}  ${chapter.title}`);
  if (commandCallouts[chapter.id]) writeFileSync(commandPath, commandCallouts[chapter.id]);

  const filters = [
    "drawbox=x=0:y=884:w=iw:h=196:color=0x07101f@0.88:t=fill:enable='lt(t,5.2)'",
    `drawtext=fontfile='${font}':textfile='${titlePath}':fontcolor=white:fontsize=42:x=58:y=926:enable='lt(t,5.2)'`,
    "drawtext=fontfile='/System/Library/Fonts/Supplemental/Arial.ttf':text='LIVE DEMO':fontcolor=0x86a9ff:fontsize=20:x=61:y=984:enable='lt(t,5.2)'",
  ];
  if (commandCallouts[chapter.id]) {
    filters.push(
      "drawbox=x=48:y=48:w=1160:h=86:color=0x10213d@0.92:t=fill:enable='between(t,5.7,11.5)'",
      `drawtext=fontfile='${font}':textfile='${commandPath}':fontcolor=white:fontsize=30:x=78:y=78:enable='between(t,5.7,11.5)'`,
    );
  }
  run("ffmpeg", [
    "-y",
    "-i",
    base,
    "-vf",
    filters.join(","),
    "-t",
    String(duration),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    output,
  ]);
}

function muxNarration(video, narration, output, duration) {
  run("ffmpeg", [
    "-y",
    "-i",
    video,
    "-i",
    narration,
    "-filter_complex",
    `[1:a]loudnorm=I=-16:LRA=7:TP=-1.5,adelay=${Math.round(leadIn * 1000)}:all=1,apad=pad_dur=${tail}[a]`,
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-t",
    String(duration),
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    output,
  ]);
}

function timestamp(value) {
  const totalMilliseconds = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secondsValue = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secondsValue).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function sentenceCues(text, start, audioDuration) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [text];
  const weights = sentences.map((sentence) => sentence.split(/\s+/).length);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = start + leadIn;
  return sentences.map((sentence, index) => {
    const duration = audioDuration * (weights[index] / total);
    const cue = { start: cursor, end: cursor + duration, text: sentence };
    cursor += duration;
    return cue;
  });
}

mkdirSync(generatedDirectory, { recursive: true });
const timing = [];
let cursor = 0;

for (const chapter of chapters) {
  const narration = join(workDirectory, "voice", `${chapter.id}.mp3`);
  const audioDuration = probeDuration(narration);
  const durationFrames = Math.ceil((audioDuration + leadIn + tail) * 30)
    + (chapter.id === chapters.at(-1).id ? 1 : 0);
  const duration = seconds(durationFrames / 30);
  const base = join(generatedDirectory, `${chapter.id}-base.mp4`);
  const titled = join(generatedDirectory, `${chapter.id}-titled.mp4`);
  const scene = join(generatedDirectory, `${chapter.id}-scene.mp4`);

  if (chapter.id === "02") {
    makeHybridClip(chapter.id, "02-skill-install.png", chapter.visual, base, duration, 0.52);
  } else if (chapter.id === "08") {
    makeHybridClip(chapter.id, "03-workspace-overview.png", chapter.visual, base, duration, 0.64);
  } else if (screenshots[chapter.id]) {
    makeScreenshotSequence(chapter.id, screenshots[chapter.id], base, duration);
  } else {
    makeRecordedClip(join(workDirectory, chapter.visual), base, duration);
  }
  overlayChapter(base, chapter, titled, duration);
  muxNarration(titled, narration, scene, duration);
  timing.push({
    id: chapter.id,
    title: chapter.title,
    start: seconds(cursor),
    end: seconds(cursor + duration),
    duration,
    narrationDuration: seconds(audioDuration),
  });
  cursor += duration;
}

const concatList = join(generatedDirectory, "scenes.txt");
writeFileSync(
  concatList,
  timing.map(({ id }) => `file '${join(generatedDirectory, `${id}-scene.mp4`).replaceAll("'", "'\\''")}'`).join("\n"),
);

const output = join(artifactDirectory, "auto-qa-live-demo.mp4");
const sceneInputs = timing.flatMap(({ id }) => ["-i", join(generatedDirectory, `${id}-scene.mp4`)]);
const narrationInputs = timing.flatMap(({ id }) => ["-i", join(workDirectory, "voice", `${id}.mp3`)]);
const normalizedVideo = timing.map((_, index) =>
  `[${index}:v]fps=30,setpts=PTS-STARTPTS[v${index}]`,
);
const normalizedAudio = timing.map((chapter, index) => {
  const samples = Math.round(chapter.duration * 48_000);
  return `[${timing.length + index}:a]loudnorm=I=-16:LRA=7:TP=-1.5,aresample=48000,adelay=${Math.round(leadIn * 1000)}:all=1,asetpts=N/SR/TB,apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[a${index}]`;
});
const videoStreams = timing.map((_, index) => `[v${index}]`).join("");
const audioStreams = timing.map((_, index) => `[a${index}]`).join("");
run("ffmpeg", [
  "-y",
  ...sceneInputs,
  ...narrationInputs,
  "-filter_complex",
  `${normalizedVideo.join(";")};${normalizedAudio.join(";")};${videoStreams}concat=n=${timing.length}:v=1:a=0[v];${audioStreams}concat=n=${timing.length}:v=0:a=1[a]`,
  "-map",
  "[v]",
  "-map",
  "[a]",
  "-t",
  String(seconds(cursor)),
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-fps_mode",
  "cfr",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-movflags",
  "+faststart",
  output,
]);

const encoded = probeStreamDurations(output);
const decodedAudioDuration = probeDecodedAudioDuration(output);
const plannedDuration = seconds(cursor);
const videoDelta = Math.abs(encoded.video - plannedDuration);
const avEndDelta = Math.abs(encoded.video - decodedAudioDuration);
if (videoDelta > 1 / 30 + 0.005) {
  throw new Error(`Encoded video drifted ${videoDelta.toFixed(3)}s from the frame-rounded plan`);
}
if (avEndDelta > 0.012) {
  throw new Error(`Encoded audio/video end timestamps differ by ${avEndDelta.toFixed(3)}s`);
}

run("ffmpeg", [
  "-y",
  "-i",
  output,
  "-vn",
  "-c:a",
  "libmp3lame",
  "-b:a",
  "192k",
  join(artifactDirectory, "auto-qa-live-demo-voiceover.mp3"),
]);

const cues = timing.flatMap((chapter) => {
  const source = chapters.find(({ id }) => id === chapter.id);
  return sentenceCues(source.narration, chapter.start, chapter.narrationDuration);
});
writeFileSync(
  join(artifactDirectory, "auto-qa-live-demo.vtt"),
  `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`).join("\n")}`,
);
writeFileSync(
  join(artifactDirectory, "timing.json"),
  `${JSON.stringify({
    totalDuration: seconds(encoded.video),
    plannedDuration,
    encodedAudioDuration: seconds(decodedAudioDuration),
    avEndDelta: seconds(avEndDelta),
    chapters: timing,
  }, null, 2)}\n`,
);

const contactInputs = timing.flatMap((chapter) => [
  "-ss",
  String(Math.max(0, chapter.start + chapter.duration / 2)),
  "-i",
  output,
]);
const scaled = timing.map((_, index) => `[${index}:v]scale=480:270[v${index}]`).join(";");
const stackInputs = timing.map((_, index) => `[v${index}]`).join("");
const layout = timing.map((_, index) => `${(index % 4) * 480}_${Math.floor(index / 4) * 270}`).join("|");
run("ffmpeg", [
  "-y",
  ...contactInputs,
  "-filter_complex",
  `${scaled};${stackInputs}xstack=inputs=${timing.length}:layout=${layout}[out]`,
  "-map",
  "[out]",
  "-frames:v",
  "1",
  "-update",
  "1",
  join(artifactDirectory, "contact-sheet.png"),
]);

console.log(`Rendered ${output}`);
console.log(`Duration ${seconds(encoded.video)} seconds; A/V end delta ${seconds(avEndDelta)} seconds`);
