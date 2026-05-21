import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod/v4";

import type { AnalyzeResult } from "../../result-types";
import { analyzeYoutubeTranscript, analyzeYoutubeVideo } from "../../../core/analyze";
import type { ProgressEvent } from "../../../core/types";
import { userFromRequest } from "../../../server/auth";
import { getVideoInfo } from "../../../core/download";
import { uploadAnalysisArtifacts } from "../../../server/blob-artifacts";
import {
  anonymousCookieHeader,
  anonymousIdFromRequest,
  authorizeExtraction,
  createAnonymousId,
  refundUsageGrant,
  type UsageGrant
} from "../../../server/billing";
import { estimateExtractionCostCents } from "../../../server/pricing";
import { autoRefillIfNeeded } from "../../../server/stripe";
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
      extractionKind: "'text' | 'full' (default 'full') — text-only transcript or full visual context pack",
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
    frames: "Array<{ fileName, timestamp, score, description, labels, imageUrl, imageDownloadUrl }>",
    cinematic: "{ styleMarkdown, shotSpecMarkdown, promptMarkdown, shotSpecs, slopWarnings }",
    zipUrl: "string — Blob URL of the full artifact ZIP",
    zipDownloadUrl: "string — Blob download URL of the full artifact ZIP"
  },
  examples: {
    buffered:
      "curl -s -X POST /api/analyze -H 'Content-Type: application/json' -d '{\"url\":\"https://youtu.be/VIDEO_ID\"}'",
    streaming:
      "curl -N -X POST /api/analyze -H 'Content-Type: application/json' -H 'Accept: application/x-ndjson' -d '{\"url\":\"https://youtu.be/VIDEO_ID\"}'"
  },
  notes: [
    "Requires OPENAI_API_KEY configured on the server.",
    "Guest users can run 10 free text-only extractions. Full context extractions require an authenticated web session.",
    "Completed authenticated analyses are saved to the signed-in user's Postgres video library.",
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
  extractionKind: z.enum(["text", "full"]).default("full"),
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
 * Runs the full pipeline and uploads browser assets to Vercel Blob. Blob
 * storage is required for the web path so large frame/ZIP payloads are not
 * stored inline in JSON or Postgres.
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
  return uploadAnalysisArtifacts(result);
}

async function runTextExtraction(
  body: AnalyzeRequest,
  onProgress?: (event: ProgressEvent) => void
): Promise<AnalyzeResult> {
  const result = await analyzeYoutubeTranscript({
    ...body,
    outputDir: path.join(os.tmpdir(), "yt2ctx-web"),
    onProgress
  });
  return uploadAnalysisArtifacts(result);
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
  const user = await userFromRequest(request);
  const existingAnonymousId = anonymousIdFromRequest(request);
  const anonymousId = existingAnonymousId ?? createAnonymousId();

  let body: AnalyzeRequest;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }

  if (!user && body.extractionKind === "full") {
    const response = NextResponse.json(
      { error: "Sign in to run full context extractions." },
      { status: 401 }
    );
    if (!existingAnonymousId) response.headers.append("Set-Cookie", anonymousCookieHeader(anonymousId));
    return response;
  }

  let grant: UsageGrant;
  try {
    const info = await getVideoInfo(body.url);
    const durationSeconds = info.durationSeconds || 0;
    grant = await authorizeExtraction({
      user,
      anonymousId,
      extractionKind: body.extractionKind,
      sourceUrl: body.url,
      durationSeconds,
      estimatedCostCents: estimateExtractionCostCents({
        extractionKind: body.extractionKind,
        durationSeconds,
        maxCandidateFrames: body.maxCandidateFrames,
        topK: body.topK
      })
    });
  } catch (error) {
    const response = NextResponse.json({ error: messageOf(error) }, { status: 402 });
    if (!existingAnonymousId) response.headers.append("Set-Cookie", anonymousCookieHeader(anonymousId));
    return response;
  }

  const attachBilling = (result: AnalyzeResult): AnalyzeResult => ({
    ...result,
    billing: {
      freeQuotaUsed: grant.freeQuotaUsed,
      creditsSpentCents: grant.creditsSpentCents,
      estimatedCostCents: grant.estimatedCostCents,
      remainingFree: grant.remainingFree,
      creditBalanceCents: grant.creditBalanceCents
    }
  });

  const accept = request.headers.get("accept") || "";
  const wantsStream =
    accept.includes("application/x-ndjson") || accept.includes("text/event-stream");

  if (!wantsStream) {
    try {
      const result =
        body.extractionKind === "text" ? await runTextExtraction(body) : await runAnalysis(body);
      const withBilling = attachBilling(result);
      const video = user ? await saveVideo(user, withBilling, parseYouTubeId(body.url)) : null;
      if (user) await autoRefillIfNeeded(user).catch(() => undefined);
      const response = NextResponse.json({ ...withBilling, savedVideoId: video?.id });
      if (!existingAnonymousId) response.headers.append("Set-Cookie", anonymousCookieHeader(anonymousId));
      return response;
    } catch (error) {
      await refundUsageGrant(grant);
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
        const payload =
          body.extractionKind === "text"
            ? await runTextExtraction(body, (event) => send({ type: "progress", ...event }))
            : await runAnalysis(body, (event) => send({ type: "progress", ...event }));
        const withBilling = attachBilling(payload);
        const video = user ? await saveVideo(user, withBilling, parseYouTubeId(body.url)) : null;
        if (user) await autoRefillIfNeeded(user).catch(() => undefined);
        send({ type: "result", result: { ...withBilling, savedVideoId: video?.id } });
      } catch (error) {
        await refundUsageGrant(grant);
        send({ type: "error", message: messageOf(error) });
      } finally {
        closed = true;
        controller.close();
      }
    }
  });

  const headers = new Headers({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no"
  });
  if (!existingAnonymousId) headers.append("Set-Cookie", anonymousCookieHeader(anonymousId));
  return new Response(stream, { headers });
}
