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
  imageUrl: string;
  imageDownloadUrl: string;
};

export type SlopWarning = {
  rule: string;
  whyItBreaksTaste: string;
  rejectIf: string;
  preferredMove: string;
};

export type AnalyzeResult = {
  id: string;
  createdAt: string;
  savedVideoId?: string;
  sourceUrl: string;
  extractionKind?: "text" | "full";
  billing?: {
    freeQuotaUsed: boolean;
    creditsSpentCents: number;
    estimatedCostCents: number;
    remainingFree: number;
    creditBalanceCents: number;
  };
  metadata: { title?: string; uploader?: string; durationSeconds: number };
  options: { visionModel: string; mode: string; topK: number };
  markdown: string;
  transcriptSegments?: unknown[];
  frames: Frame[];
  cinematic: {
    styleMarkdown: string;
    shotSpecMarkdown: string;
    promptMarkdown: string;
    slopWarnings: SlopWarning[];
    shotSpecs?: unknown[];
  };
  zipUrl: string;
  zipDownloadUrl: string;
};

export type User = {
  id: string;
  email: string;
  stripeCustomerId?: string | null;
};

export type BillingSummary = {
  account: {
    creditBalanceCents: number;
    autoRefillEnabled: boolean;
    autoRefillThresholdCents: number;
    autoRefillAmountCents: number;
    recurringEnabled: boolean;
    stripeSubscriptionId?: string;
    stripePaymentMethodId?: string;
  } | null;
  free: {
    anonymousTextRemaining: number;
    authenticatedTextRemaining: number;
    authenticatedFullRemaining: number;
  };
  prices: {
    text: number;
    full: number;
  };
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
