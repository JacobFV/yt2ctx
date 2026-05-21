import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod/v4";

import type { AnalyzeResult, Frame } from "../../result-types";
import { analyzeYoutubeVideo } from "../../../core/analyze";
import { attachFrameDataUrls } from "../../../core/render";
import type { ProgressEvent } from "../../../core/types";
import { requireUser, type User } from "../../../server/auth";
import { saveVideo } from "../../../server/videos";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Machine- and human-readable contract for this endpoint, served from `GET`
 * so the API is discoverable instead of answering a bare 405.
 */
const API_INFO = {
  service: "yt2ctx",
  endpoint: "/api/analyze",
  method: "POST",
  summary:
    "Analyze a YouTube video into a VLM-ready context pack: timed transcript, representative frames, and cinematic grammar artifacts.",
  request: {
    contentType: "application/json",
    body: {
      url: "string (required) — youtube.com/watch, youtu.be, or /shorts URL",
      topK: "integer 1–24 (default 8) — number of frames to select",
      mode: "'density' | 'top-k' (default 'density') — frame selection strategy",
      candidateIntervalSeconds: "number 1–120 (default 8) — seconds between sampled frames",
      maxCandidateFrames: "integer 4–80 (default 36) — candidate frames sent to vision",
      frameWidth: "integer 256–1600 (default 768) — extracted frame width in pixels"
    }
  },
  responseModes: {
    streaming:
      "Send `Accept: application/x-ndjson`. Returns newline-delimited JSON: zero or more {type:'progress',stage,label,pct,...} events, then one {type:'result',result:{...}} line. Failures arrive as a {type:'error',message} line.",
    buffered:
      "Send any other Accept value. Returns a single JSON result object, or {error} with HTTP 400 on failure."
  },
  result: {
    id: "string — job identifier",
    metadata: "{ title, uploader, durationSeconds }",
    markdown: "string — the watch pack",
    frames: "Array<{ fileName, timestamp, score, description, labels, dataUrl }>",
    cinematic: "{ styleMarkdown, shotSpecMarkdown, promptMarkdown, shotSpecs, slopWarnings }",
    zipDataUrl: "string — base64 data URL of the full artifact ZIP"
  },
  examples: {
    buffered:
      "curl -s -X POST /api/analyze -H 'Content-Type: application/json' -d '{\"url\":\"https://youtu.be/VIDEO_ID\"}'",
    streaming:
      "curl -N -X POST /api/analyze -H 'Content-Type: application/json' -H 'Accept: application/x-ndjson' -d '{\"url\":\"https://youtu.be/VIDEO_ID\"}'"
  },
  notes: [
    "Requires OPENAI_API_KEY configured on the server.",
    "Requires an authenticated web session; completed analyses are saved to the signed-in user's Postgres video library.",
    "maxDuration is 300s; long videos are better processed via the CLI or MCP server.",
    "Only analyze videos you have the right to download."
  ]
} as const;

const requestSchema = z.object({
  url: z.string().url(),
  topK: z.number().int().min(1).max(24).default(8),
  mode: z.enum(["top-k", "density"]).default("density"),
  selectionMode: z.enum(["top-k", "density"]).optional(),
  outputMode: z.enum(["watch", "style", "prompt", "shot-specs", "all"]).default("all"),
  candidateIntervalSeconds: z.number().min(1).max(120).default(8),
  maxCandidateFrames: z.number().int().min(4).max(80).default(36),
  frameWidth: z.number().int().min(256).max(1600).default(768)
});

type AnalyzeRequest = z.infer<typeof requestSchema>;

const ID_PATTERN = /^[\w-]{11}$/;

function parseYouTubeId(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return ID_PATTERN.test(id) ? id : null;
  }
  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    const v = parsed.searchParams.get("v");
    if (v && ID_PATTERN.test(v)) return v;
    const match = parsed.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (match) return match[1];
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
        return `${where}${issue.message}`;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Runs the full pipeline and assembles a browser-ready payload: every selected
 * frame carries an inline data URL and the artifact ZIP is base64-encoded so
 * the client needs no follow-up requests.
 */
async function runAnalysis(
  body: AnalyzeRequest,
  onProgress?: (event: ProgressEvent) => void
): Promise<AnalyzeResult> {
  const result = await analyzeYoutubeVideo({
    ...body,
    // Vercel and most hosts only allow writes under the OS temp dir.
    outputDir: path.join(os.tmpdir(), "yt2ctx-web"),
    onProgress
  });
  const frames = (await attachFrameDataUrls(result.frames)) as Frame[];
  const zipBuffer = await readFile(result.artifacts.zipPath);
  return {
    ...result,
    frames,
    zipDataUrl: `data:application/zip;base64,${zipBuffer.toString("base64")}`
  };
}

/** GET /api/analyze — return the endpoint contract so the API is discoverable. */
export function GET() {
  return NextResponse.json(API_INFO);
}

/**
 * POST /api/analyze
 *
 * Content negotiation keeps both audiences happy:
 *  - `Accept: application/x-ndjson` streams newline-delimited progress events
 *    (`{type:"progress"}` ...) and ends with a single `{type:"result"}` line.
 *    The web client uses this for live progress.
 *  - Any other Accept value returns one buffered JSON object — the result —
 *    which is the simplest thing for headless agents to consume.
 */
export async function POST(request: Request) {
  let user: User;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: AnalyzeRequest;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }

  const accept = request.headers.get("accept") || "";
  const wantsStream =
    accept.includes("application/x-ndjson") || accept.includes("text/event-stream");

  if (!wantsStream) {
    try {
      const result = await runAnalysis(body);
      const video = await saveVideo(user, result, parseYouTubeId(body.url));
      return NextResponse.json({ ...result, savedVideoId: video.id });
    } catch (error) {
      return NextResponse.json({ error: messageOf(error) }, { status: 400 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const payload = await runAnalysis(body, (event) => send({ type: "progress", ...event }));
        const video = await saveVideo(user, payload, parseYouTubeId(body.url));
        send({ type: "result", result: { ...payload, savedVideoId: video.id } });
      } catch (error) {
        send({ type: "error", message: messageOf(error) });
      } finally {
        closed = true;
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}
