#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { analyzeYoutubeVideo } from "./core/analyze";
import type { FrameSelectionMode } from "./core/types";

const server = new McpServer({
  name: "yt-view",
  version: "1.0.0"
});

server.registerTool(
  "watch_youtube",
  {
    title: "Watch YouTube for VLM context",
    description:
      "Downloads a YouTube video, transcribes it with timestamps, selects representative frames, and returns copy-pasteable VLM context plus selected frame images.",
    inputSchema: {
      url: z.string().url().describe("YouTube video URL"),
      topK: z.number().int().min(1).max(24).default(8),
      mode: z.enum(["top-k", "density"]).default("density"),
      candidateIntervalSeconds: z.number().min(1).max(120).default(8),
      maxCandidateFrames: z.number().int().min(4).max(80).default(36),
      frameWidth: z.number().int().min(256).max(1600).default(768),
      outputDir: z.string().optional()
    }
  },
  async (args) => {
    const result = await analyzeYoutubeVideo({
      url: args.url,
      topK: args.topK,
      mode: args.mode as FrameSelectionMode,
      candidateIntervalSeconds: args.candidateIntervalSeconds,
      maxCandidateFrames: args.maxCandidateFrames,
      frameWidth: args.frameWidth,
      outputDir: args.outputDir
    });

    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [
      {
        type: "text",
        text:
          `${result.markdown}\n` +
          `\nArtifacts directory: ${result.artifacts.outputDir}\n` +
          `ZIP: ${result.artifacts.zipPath}\n`
      }
    ];

    for (const frame of result.frames) {
      content.push({
        type: "image",
        data: (await readFile(frame.path)).toString("base64"),
        mimeType: "image/jpeg"
      });
    }

    return { content };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
