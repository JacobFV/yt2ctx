import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { defaultOutputDir, getOpenAiKey } from "./env";
import { downloadVideo, getVideoInfo } from "./download";
import { extractAudio, extractCandidateFrames, getDurationSeconds, splitAudio } from "./media";
import {
  analyzeCinematicGrammar,
  analyzeFramesSemantically,
  createOpenAiClient,
  transcribeAudioChunks
} from "./openai";
import { createProgressTracker } from "./progress";
import { persistArtifacts, moveSelectedFrames } from "./render";
import { selectFrames } from "./select";
import { slugify } from "./time";
import type { AnalyzeVideoOptions, VideoAnalysisResult } from "./types";

const DEFAULTS = {
  topK: 8,
  mode: "density" as const,
  outputMode: "all" as const,
  candidateIntervalSeconds: 8,
  maxCandidateFrames: 36,
  frameWidth: 768,
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
  visionModel: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small"
};

export async function analyzeYoutubeVideo(options: AnalyzeVideoOptions): Promise<VideoAnalysisResult> {
  const apiKey = getOpenAiKey(options.openAiApiKey);
  const resolved = {
    ...DEFAULTS,
    ...options,
    topK: options.topK ?? DEFAULTS.topK,
    mode: options.selectionMode ?? options.mode ?? DEFAULTS.mode,
    outputMode: options.outputMode ?? DEFAULTS.outputMode,
    candidateIntervalSeconds:
      options.candidateIntervalSeconds ?? DEFAULTS.candidateIntervalSeconds,
    maxCandidateFrames: options.maxCandidateFrames ?? DEFAULTS.maxCandidateFrames,
    frameWidth: options.frameWidth ?? DEFAULTS.frameWidth,
    transcribeModel: options.transcribeModel ?? DEFAULTS.transcribeModel,
    visionModel: options.visionModel ?? DEFAULTS.visionModel,
    embeddingModel: options.embeddingModel ?? DEFAULTS.embeddingModel
  };

  const tracker = createProgressTracker(options.onProgress);
  const client = createOpenAiClient(apiKey);

  tracker.report("info");
  const info = await getVideoInfo(resolved.url);
  const jobId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
    .randomBytes(4)
    .toString("hex")}-${slugify(info.title || info.id || "video")}`;
  const outputRoot = path.resolve(resolved.outputDir || defaultOutputDir(), jobId);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "yt2ctx-"));

  try {
    const videoPath = path.join(workDir, "video.mp4");
    const audioPath = path.join(workDir, "audio.mp3");
    const chunkDir = path.join(workDir, "chunks");
    const candidateDir = path.join(workDir, "candidate-frames");
    const frameDir = path.join(outputRoot, "frames");

    tracker.report("download", { detail: info.title || undefined });
    await downloadVideo(resolved.url, videoPath);
    const duration = info.durationSeconds || (await getDurationSeconds(videoPath));
    const metadata = { ...info, durationSeconds: duration };

    tracker.report("audio");
    await extractAudio(videoPath, audioPath);
    const chunkSeconds = 900;
    const chunks = await splitAudio(audioPath, chunkDir, chunkSeconds);

    tracker.report("transcribe", { current: 0, total: chunks.length });
    const transcript = await transcribeAudioChunks({
      client,
      chunks,
      chunkSeconds,
      model: resolved.transcribeModel,
      onProgress: (current, total) =>
        tracker.report("transcribe", {
          current,
          total,
          detail: total > 1 ? `Segment ${current} of ${total}` : undefined
        })
    });

    tracker.report("frames");
    const candidates = await extractCandidateFrames({
      videoPath,
      frameDir: candidateDir,
      durationSeconds: duration,
      intervalSeconds: resolved.candidateIntervalSeconds,
      maxCandidateFrames: resolved.maxCandidateFrames,
      width: resolved.frameWidth,
      onFrame: (current, total) =>
        tracker.report("frames", { current, total, detail: `Frame ${current} of ${total}` })
    });

    tracker.report("vision", { current: 0, total: candidates.length });
    const analyzedFrames = await analyzeFramesSemantically({
      client,
      candidates,
      transcriptSegments: transcript.segments,
      visionModel: resolved.visionModel,
      embeddingModel: resolved.embeddingModel,
      onProgress: (phase, current, total) => {
        if (phase === "vision") {
          tracker.report("vision", { current, total, detail: `Frame ${current} of ${total}` });
        } else {
          tracker.report("embed", { current, total });
        }
      }
    });

    tracker.report("select");
    const selected = selectFrames(analyzedFrames, resolved.topK, resolved.mode);
    const frames = await moveSelectedFrames({ selectedFrames: selected, frameDir });

    tracker.report("cinematic", { detail: "Reading selected frames as production evidence" });
    const cinematic = await analyzeCinematicGrammar({
      client,
      model: resolved.visionModel,
      metadataTitle: metadata.title || "YouTube video",
      sourceUrl: resolved.url,
      transcriptText: transcript.text,
      frames
    });

    const resultWithoutMarkdown = {
      id: jobId,
      createdAt: new Date().toISOString(),
      sourceUrl: resolved.url,
      extractionKind: "full" as const,
      metadata,
      options: {
        topK: resolved.topK,
        mode: resolved.mode,
        outputMode: resolved.outputMode,
        candidateIntervalSeconds: resolved.candidateIntervalSeconds,
        maxCandidateFrames: resolved.maxCandidateFrames,
        frameWidth: resolved.frameWidth,
        transcribeModel: resolved.transcribeModel,
        visionModel: resolved.visionModel,
        embeddingModel: resolved.embeddingModel
      },
      transcriptText: transcript.text,
      transcriptSegments: transcript.segments,
      frames,
      cinematic,
      artifacts: {
        outputDir: outputRoot,
        markdownPath: path.join(outputRoot, "watch.md"),
        stylePath: path.join(outputRoot, "style-bible.md"),
        shotSpecsPath: path.join(outputRoot, "shot-specs.json"),
        shotSpecsMarkdownPath: path.join(outputRoot, "shot-specs.md"),
        codexPromptPath: path.join(outputRoot, "codex-prompt.md"),
        metadataPath: path.join(outputRoot, "metadata.json"),
        zipPath: path.join(outputRoot, "yt2ctx-artifacts.zip"),
        frameDir
      }
    };

    tracker.report("artifacts");
    const markdown = await persistArtifacts(resultWithoutMarkdown);
    tracker.report("done");
    return {
      ...resultWithoutMarkdown,
      markdown
    };
  } finally {
    if (!resolved.keepWorkDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

export async function analyzeYoutubeTranscript(options: AnalyzeVideoOptions): Promise<VideoAnalysisResult> {
  const apiKey = getOpenAiKey(options.openAiApiKey);
  const resolved = {
    ...DEFAULTS,
    ...options,
    outputMode: "watch" as const,
    transcribeModel: options.transcribeModel ?? DEFAULTS.transcribeModel,
    visionModel: options.visionModel ?? DEFAULTS.visionModel,
    embeddingModel: options.embeddingModel ?? DEFAULTS.embeddingModel
  };

  const tracker = createProgressTracker(options.onProgress);
  const client = createOpenAiClient(apiKey);

  tracker.report("info");
  const info = await getVideoInfo(resolved.url);
  const jobId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
    .randomBytes(4)
    .toString("hex")}-${slugify(info.title || info.id || "video")}`;
  const outputRoot = path.resolve(resolved.outputDir || defaultOutputDir(), jobId);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "yt2ctx-"));

  try {
    const videoPath = path.join(workDir, "video.mp4");
    const audioPath = path.join(workDir, "audio.mp3");
    const chunkDir = path.join(workDir, "chunks");
    const frameDir = path.join(outputRoot, "frames");

    tracker.report("download", { detail: info.title || undefined });
    await downloadVideo(resolved.url, videoPath);
    const duration = info.durationSeconds || (await getDurationSeconds(videoPath));
    const metadata = { ...info, durationSeconds: duration };

    tracker.report("audio");
    await extractAudio(videoPath, audioPath);
    const chunkSeconds = 900;
    const chunks = await splitAudio(audioPath, chunkDir, chunkSeconds);

    tracker.report("transcribe", { current: 0, total: chunks.length });
    const transcript = await transcribeAudioChunks({
      client,
      chunks,
      chunkSeconds,
      model: resolved.transcribeModel,
      onProgress: (current, total) =>
        tracker.report("transcribe", {
          current,
          total,
          detail: total > 1 ? `Segment ${current} of ${total}` : undefined
        })
    });

    const resultWithoutMarkdown = {
      id: jobId,
      createdAt: new Date().toISOString(),
      sourceUrl: resolved.url,
      extractionKind: "text" as const,
      metadata,
      options: {
        topK: resolved.topK,
        mode: resolved.mode,
        outputMode: resolved.outputMode,
        candidateIntervalSeconds: resolved.candidateIntervalSeconds,
        maxCandidateFrames: resolved.maxCandidateFrames,
        frameWidth: resolved.frameWidth,
        transcribeModel: resolved.transcribeModel,
        visionModel: resolved.visionModel,
        embeddingModel: resolved.embeddingModel
      },
      transcriptText: transcript.text,
      transcriptSegments: transcript.segments,
      frames: [],
      cinematic: {
        styleBible: {
          title: metadata.title || "YouTube video",
          oneSentenceThesis: "Text-only extraction captured the transcript without visual analysis.",
          referenceLineage: ["reference video transcript", "text-only context extraction"],
          productionOntology: "No visual ontology was generated for this text-only extraction.",
          cinematicPrinciples: [],
          visualLanguage: {
            camera: "",
            lensing: "",
            lighting: "",
            composition: "",
            colorPalette: "",
            materiality: "",
            motion: "",
            editing: "",
            typography: "",
            sound: "",
            performance: ""
          },
          narrationLanguage: {
            register: "",
            syntaxRules: [],
            openingPatterns: [],
            forbiddenPhrases: [],
            sampleLines: []
          },
          shotPatterns: [],
          transferRules: []
        },
        shotSpecs: [],
        codexPrompt: "",
        slopWarnings: [],
        styleMarkdown: "Text-only extraction. Upgrade to a full context extraction for visual grammar.",
        shotSpecMarkdown: "Text-only extraction. No shot specs were generated.",
        promptMarkdown: "Text-only extraction. No Codex prompt was generated."
      },
      artifacts: {
        outputDir: outputRoot,
        markdownPath: path.join(outputRoot, "watch.md"),
        stylePath: path.join(outputRoot, "style-bible.md"),
        shotSpecsPath: path.join(outputRoot, "shot-specs.json"),
        shotSpecsMarkdownPath: path.join(outputRoot, "shot-specs.md"),
        codexPromptPath: path.join(outputRoot, "codex-prompt.md"),
        metadataPath: path.join(outputRoot, "metadata.json"),
        zipPath: path.join(outputRoot, "yt2ctx-artifacts.zip"),
        frameDir
      }
    };

    tracker.report("artifacts");
    const markdown = await persistArtifacts(resultWithoutMarkdown);
    tracker.report("done");
    return {
      ...resultWithoutMarkdown,
      markdown
    };
  } finally {
    if (!resolved.keepWorkDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
