import { randomUUID } from "node:crypto";

import type { AnalyzeResult } from "../app/result-types";
import { ensureSchema, sql } from "./db";
import type { User } from "./auth";

export type SavedVideoSummary = {
  id: string;
  analysisId: string;
  sourceUrl: string;
  videoId: string | null;
  title: string;
  uploader?: string;
  durationSeconds: number;
  frameCount: number;
  createdAt: string;
};

export type SavedVideo = SavedVideoSummary & {
  result: AnalyzeResult;
};

type VideoRow = {
  id: string;
  analysis_id: string;
  source_url: string;
  video_id: string | null;
  title: string;
  uploader: string | null;
  duration_seconds: number | string | null;
  frame_count: number | string | null;
  created_at: string | Date;
  result?: unknown;
};

export async function saveVideo(
  user: User,
  result: AnalyzeResult,
  videoId: string | null
): Promise<SavedVideo> {
  await ensureSchema();
  const id = randomUUID();
  const title = result.metadata.title?.trim() || "Untitled video";
  const durationSeconds = Math.max(0, Math.floor(result.metadata.durationSeconds || 0));
  const frameCount = result.frames.length;
  const rows = await sql`
    INSERT INTO videos (
      id,
      user_id,
      analysis_id,
      source_url,
      video_id,
      title,
      uploader,
      duration_seconds,
      frame_count,
      result
    )
    VALUES (
      ${id},
      ${user.id},
      ${result.id},
      ${result.sourceUrl},
      ${videoId},
      ${title},
      ${result.metadata.uploader ?? null},
      ${durationSeconds},
      ${frameCount},
      ${JSON.stringify(result)}::jsonb
    )
    RETURNING id, analysis_id, source_url, video_id, title, uploader, duration_seconds, frame_count, created_at, result
  `;
  return rowToVideo(rows[0] as VideoRow);
}

export async function listVideos(user: User): Promise<SavedVideoSummary[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT id, analysis_id, source_url, video_id, title, uploader, duration_seconds, frame_count, created_at
    FROM videos
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC
  `;
  return (rows as VideoRow[]).map(rowToSummary);
}

export async function getVideo(user: User, id: string): Promise<SavedVideo | null> {
  await ensureSchema();
  const rows = await sql`
    SELECT id, analysis_id, source_url, video_id, title, uploader, duration_seconds, frame_count, created_at, result
    FROM videos
    WHERE user_id = ${user.id}
      AND id = ${id}
    LIMIT 1
  `;
  return rows[0] ? rowToVideo(rows[0] as VideoRow) : null;
}

export async function deleteVideo(user: User, id: string): Promise<void> {
  await ensureSchema();
  await sql`
    DELETE FROM videos
    WHERE user_id = ${user.id}
      AND id = ${id}
  `;
}

function rowToSummary(row: VideoRow): SavedVideoSummary {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    sourceUrl: row.source_url,
    videoId: row.video_id,
    title: row.title,
    uploader: row.uploader ?? undefined,
    durationSeconds: Number(row.duration_seconds ?? 0),
    frameCount: Number(row.frame_count ?? 0),
    createdAt: new Date(row.created_at).toISOString()
  };
}

function rowToVideo(row: VideoRow): SavedVideo {
  return {
    ...rowToSummary(row),
    result: row.result as AnalyzeResult
  };
}
