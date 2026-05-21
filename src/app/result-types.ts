/* ------------------------------------------------------------------ *
 * The slice of the /api/analyze payload the web UI actually touches.   *
 * Shared by the page component and the saved-conversation store.       *
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
