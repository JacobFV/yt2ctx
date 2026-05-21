import type { ExtractionKind } from "../core/types";

export const FREE_TEXT_EXTRACTIONS_ANONYMOUS = 10;
export const FREE_TEXT_EXTRACTIONS_AUTHENTICATED = 100;
export const FREE_FULL_EXTRACTIONS_AUTHENTICATED = 10;
export const PLATFORM_MAX_NET_LOSS_CENTS = 1000;

export const CREDIT_PRICES_CENTS: Record<ExtractionKind, number> = {
  text: 5,
  full: 75
};

export const CREDIT_PACKS = {
  starter: {
    id: "starter",
    name: "Starter credits",
    amountCents: 500,
    creditsCents: 500
  },
  studio: {
    id: "studio",
    name: "Studio credits",
    amountCents: 2000,
    creditsCents: 2200
  }
} as const;

export const RECURRING_PACK = {
  id: "monthly",
  name: "Monthly credit refill",
  amountCents: 1000,
  creditsCents: 1100,
  interval: "month"
} as const;

export type CreditPackId = keyof typeof CREDIT_PACKS;

export function estimateExtractionCostCents(params: {
  extractionKind: ExtractionKind;
  durationSeconds: number;
  maxCandidateFrames?: number;
  topK?: number;
}): number {
  const minutes = Math.max(1, params.durationSeconds / 60);
  const sttCents = minutes * 0.6;
  if (params.extractionKind === "text") return Math.max(1, Math.ceil(sttCents));

  const candidates = Math.max(4, params.maxCandidateFrames ?? 36);
  const selected = Math.max(1, params.topK ?? 8);
  const frameDescriptionCents = candidates * 0.18;
  const embeddingCents = Math.max(0.2, candidates * 0.01);
  const cinematicCents = 2.5 + selected * 0.08;
  return Math.max(5, Math.ceil(sttCents + frameDescriptionCents + embeddingCents + cinematicCents));
}
