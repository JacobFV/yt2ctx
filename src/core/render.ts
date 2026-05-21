import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import { formatTimestamp } from "./time";
import type { FrameAnalysis, TranscriptSegment, VideoAnalysisResult, VideoMetadata } from "./types";

export function renderMarkdown(params: {
  sourceUrl: string;
  metadata: VideoMetadata;
  transcriptSegments: TranscriptSegment[];
  frames: FrameAnalysis[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${params.metadata.title || "YouTube video"}`);
  lines.push("");
  lines.push(`Source: ${params.sourceUrl}`);
  if (params.metadata.uploader) lines.push(`Uploader: ${params.metadata.uploader}`);
  lines.push(`Duration: ${formatTimestamp(params.metadata.durationSeconds)}`);
  lines.push("");
  lines.push("Generated artifacts: `watch.md`, `style-bible.md`, `shot-specs.md`, `shot-specs.json`, `codex-prompt.md`, selected frame JPGs, and a ZIP bundle.");
  lines.push("");
  lines.push("## Representative frames");
  lines.push("");
  for (const frame of params.frames) {
    lines.push(
      `### Frame ${frame.index + 1} - ${formatTimestamp(frame.timestamp)} - score ${frame.score.toFixed(3)}`
    );
    lines.push(`File: ${frame.fileName}`);
    lines.push(`Description: ${frame.description}`);
    if (frame.labels.length) lines.push(`Tags: ${frame.labels.join(", ")}`);
    if (frame.transcriptContext) lines.push(`Nearby transcript: ${frame.transcriptContext}`);
    lines.push("");
  }
  lines.push("## Transcript");
  lines.push("");
  for (const segment of params.transcriptSegments) {
    lines.push(
      `[${formatTimestamp(segment.start)} - ${formatTimestamp(segment.end)}] ${segment.text}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function persistArtifacts(result: Omit<VideoAnalysisResult, "markdown">): Promise<string> {
  await mkdir(result.artifacts.outputDir, { recursive: true });
  const markdown = renderMarkdown({
    sourceUrl: result.sourceUrl,
    metadata: result.metadata,
    transcriptSegments: result.transcriptSegments,
    frames: result.frames
  });

  await writeFile(result.artifacts.markdownPath, markdown, "utf8");
  await writeFile(result.artifacts.stylePath, result.cinematic.styleMarkdown, "utf8");
  await writeFile(result.artifacts.shotSpecsMarkdownPath, result.cinematic.shotSpecMarkdown, "utf8");
  await writeFile(
    result.artifacts.shotSpecsPath,
    JSON.stringify(result.cinematic.shotSpecs, null, 2),
    "utf8"
  );
  await writeFile(result.artifacts.codexPromptPath, result.cinematic.promptMarkdown, "utf8");
  await writeFile(
    result.artifacts.metadataPath,
    JSON.stringify(
      {
        ...result,
        markdown: undefined
      },
      null,
      2
    ),
    "utf8"
  );

  const zip = new JSZip();
  zip.file("watch.md", markdown);
  zip.file("style-bible.md", result.cinematic.styleMarkdown);
  zip.file("shot-specs.md", result.cinematic.shotSpecMarkdown);
  zip.file("shot-specs.json", JSON.stringify(result.cinematic.shotSpecs, null, 2));
  zip.file("codex-prompt.md", result.cinematic.promptMarkdown);
  zip.file("metadata.json", JSON.stringify({ ...result, markdown: undefined }, null, 2));
  for (const frame of result.frames) {
    zip.file(`frames/${frame.fileName}`, await readFile(frame.path));
  }
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(result.artifacts.zipPath, zipBuffer);

  return markdown;
}

export async function moveSelectedFrames(params: {
  selectedFrames: FrameAnalysis[];
  frameDir: string;
}): Promise<FrameAnalysis[]> {
  await mkdir(params.frameDir, { recursive: true });
  const moved: FrameAnalysis[] = [];
  for (let outputIndex = 0; outputIndex < params.selectedFrames.length; outputIndex += 1) {
    const frame = params.selectedFrames[outputIndex];
    const fileName = `frame-${(outputIndex + 1).toString().padStart(2, "0")}-${formatTimestamp(
      frame.timestamp
    ).replace(/[:.]/g, "-")}.jpg`;
    const destination = path.join(params.frameDir, fileName);
    await rename(frame.path, destination);
    moved.push({
      ...frame,
      path: destination,
      fileName
    });
  }
  return moved;
}

export async function attachFrameDataUrls(frames: FrameAnalysis[]): Promise<FrameAnalysis[]> {
  return Promise.all(
    frames.map(async (frame) => ({
      ...frame,
      dataUrl: `data:image/jpeg;base64,${(await readFile(frame.path)).toString("base64")}`
    }))
  );
}
