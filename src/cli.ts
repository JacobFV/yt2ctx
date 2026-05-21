#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";

import { analyzeYoutubeVideo } from "./core/analyze";
import { attachFrameDataUrls } from "./core/render";
import type { FrameSelectionMode } from "./core/types";

const program = new Command();

program
  .name("yt-view")
  .description("Create a timed transcript and representative frame pack from a YouTube URL.")
  .argument("<url>", "YouTube video URL")
  .option("-o, --output <dir>", "output directory")
  .option("-k, --top-k <number>", "number of frames to select", (value) => Number.parseInt(value, 10), 8)
  .option("-m, --mode <mode>", "selection mode: top-k or density", "density")
  .option("--candidate-interval <seconds>", "seconds between candidate frames", (value) => Number.parseFloat(value), 8)
  .option("--max-candidates <number>", "maximum candidate frames to send through vision analysis", (value) => Number.parseInt(value, 10), 36)
  .option("--frame-width <pixels>", "extracted frame width", (value) => Number.parseInt(value, 10), 768)
  .option("--json", "print JSON metadata instead of markdown")
  .option("--with-data-urls", "include base64 data URLs in JSON output")
  .action(async (url: string, opts: Record<string, unknown>) => {
    const mode = String(opts.mode) as FrameSelectionMode;
    if (!["top-k", "density"].includes(mode)) {
      throw new Error("--mode must be either top-k or density");
    }

    const result = await analyzeYoutubeVideo({
      url,
      outputDir: opts.output ? String(opts.output) : undefined,
      topK: Number(opts.topK),
      mode,
      candidateIntervalSeconds: Number(opts.candidateInterval),
      maxCandidateFrames: Number(opts.maxCandidates),
      frameWidth: Number(opts.frameWidth)
    });

    if (opts.json) {
      const frames = opts.withDataUrls ? await attachFrameDataUrls(result.frames) : result.frames;
      process.stdout.write(JSON.stringify({ ...result, frames }, null, 2));
    } else {
      process.stdout.write(`${await readFile(result.artifacts.markdownPath, "utf8")}\n`);
      process.stderr.write(`\nArtifacts written to ${path.relative(process.cwd(), result.artifacts.outputDir)}\n`);
    }
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`yt-view failed: ${message}\n`);
  process.exit(1);
});
