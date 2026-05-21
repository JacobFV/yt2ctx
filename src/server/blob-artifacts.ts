import { readFile } from "node:fs/promises";
import { put } from "@vercel/blob";

import type { AnalyzeResult, Frame } from "../app/result-types";
import type { FrameAnalysis, VideoAnalysisResult } from "../core/types";

function assertBlobConfigured(): void {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
  }
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

async function uploadFrame(jobId: string, frame: FrameAnalysis): Promise<Frame> {
  const blob = await put(
    `analyses/${safePathPart(jobId)}/frames/${safePathPart(frame.fileName)}`,
    await readFile(frame.path),
    {
      access: "public",
      contentType: "image/jpeg",
      cacheControlMaxAge: 31536000,
      allowOverwrite: true
    }
  );

  return {
    fileName: frame.fileName,
    index: frame.index,
    timestamp: frame.timestamp,
    score: frame.score,
    description: frame.description,
    labels: frame.labels,
    transcriptContext: frame.transcriptContext,
    imageUrl: blob.url,
    imageDownloadUrl: blob.downloadUrl
  };
}

export async function uploadAnalysisArtifacts(
  result: VideoAnalysisResult
): Promise<AnalyzeResult> {
  assertBlobConfigured();
  const frames = await Promise.all(result.frames.map((frame) => uploadFrame(result.id, frame)));
  const zipBlob = await put(
    `analyses/${safePathPart(result.id)}/yt2ctx-artifacts.zip`,
    await readFile(result.artifacts.zipPath),
    {
      access: "public",
      contentType: "application/zip",
      cacheControlMaxAge: 31536000,
      allowOverwrite: true,
      multipart: true
    }
  );

  return {
    id: result.id,
    createdAt: result.createdAt,
    sourceUrl: result.sourceUrl,
    extractionKind: result.extractionKind,
    metadata: result.metadata,
    options: result.options,
    markdown: result.markdown,
    transcriptSegments: result.transcriptSegments,
    frames,
    cinematic: result.cinematic,
    zipUrl: zipBlob.url,
    zipDownloadUrl: zipBlob.downloadUrl
  };
}
