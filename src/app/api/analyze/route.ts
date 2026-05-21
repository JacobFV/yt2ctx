import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { analyzeYoutubeVideo } from "../../../core/analyze";
import { attachFrameDataUrls } from "../../../core/render";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  url: z.string().url(),
  topK: z.number().int().min(1).max(24).default(8),
  mode: z.enum(["top-k", "density"]).default("density"),
  candidateIntervalSeconds: z.number().min(1).max(120).default(8),
  maxCandidateFrames: z.number().int().min(4).max(80).default(36),
  frameWidth: z.number().int().min(256).max(1600).default(768)
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const result = await analyzeYoutubeVideo(body);
    const frames = await attachFrameDataUrls(result.frames);
    const zipBuffer = await readFile(result.artifacts.zipPath);

    return NextResponse.json({
      ...result,
      frames,
      zipDataUrl: `data:application/zip;base64,${zipBuffer.toString("base64")}`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
