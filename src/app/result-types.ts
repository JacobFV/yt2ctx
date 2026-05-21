/* ------------------------------------------------------------------ *
 * The slice of the /api/analyze payload the web UI actually touches.   *
 * Shared by the page component, API routes, and database row helpers.  *
 * ------------------------------------------------------------------ */

export type Frame = {
  fileName: string;
  index: number;
  timestamp: number;
  score: number;
  description: string;
  labels: string[];
  transcriptContext?: string;
  dataUrl: string;
};

export type SlopWarning = {
  rule: string;
  whyItBreaksTaste: string;
  rejectIf: string;
  preferredMove: string;
};

export type AnalyzeResult = {
  id: string;
  savedVideoId?: string;
  sourceUrl: string;
  metadata: { title?: string; uploader?: string; durationSeconds: number };
  options: { visionModel: string; mode: string; topK: number };
  markdown: string;
  frames: Frame[];
  cinematic: {
    styleMarkdown: string;
    shotSpecMarkdown: string;
    promptMarkdown: string;
    slopWarnings: SlopWarning[];
    shotSpecs?: unknown[];
  };
  zipDataUrl: string;
};

export type User = {
  id: string;
  email: string;
};

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
