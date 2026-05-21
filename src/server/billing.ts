import { randomUUID } from "node:crypto";

import type { ExtractionKind } from "../core/types";
import type { User } from "./auth";
import { ensureSchema, sql } from "./db";
import {
  CREDIT_PRICES_CENTS,
  FREE_FULL_EXTRACTIONS_AUTHENTICATED,
  FREE_TEXT_EXTRACTIONS_ANONYMOUS,
  FREE_TEXT_EXTRACTIONS_AUTHENTICATED,
  PLATFORM_MAX_NET_LOSS_CENTS
} from "./pricing";

export const ANONYMOUS_USAGE_COOKIE = "yt2ctx_anon";

export type BillingAccount = {
  creditBalanceCents: number;
  autoRefillEnabled: boolean;
  autoRefillThresholdCents: number;
  autoRefillAmountCents: number;
  recurringEnabled: boolean;
  stripeSubscriptionId?: string;
  stripePaymentMethodId?: string;
};

export type UsageGrant = {
  grantId: string;
  extractionKind: ExtractionKind;
  billToUserId: string | null;
  anonymousId: string | null;
  freeQuotaUsed: boolean;
  creditsSpentCents: number;
  estimatedCostCents: number;
  remainingFree: number;
  creditBalanceCents: number;
};

type BillingRow = {
  credit_balance_cents: number | string;
  auto_refill_enabled: boolean;
  auto_refill_threshold_cents: number | string;
  auto_refill_amount_cents: number | string;
  recurring_enabled: boolean;
  stripe_subscription_id: string | null;
  stripe_payment_method_id: string | null;
};

export function anonymousIdFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const cookie of header.split(";").map((part) => part.trim())) {
    const [name, ...value] = cookie.split("=");
    if (name === ANONYMOUS_USAGE_COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function createAnonymousId(): string {
  return randomUUID();
}

export function anonymousCookieHeader(anonymousId: string): string {
  const maxAge = 60 * 60 * 24 * 365;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ANONYMOUS_USAGE_COOKIE}=${encodeURIComponent(
    anonymousId
  )}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secure}`;
}

export async function getOrCreateBillingAccount(user: User): Promise<BillingAccount> {
  await ensureSchema();
  const rows = await sql`
    INSERT INTO billing_accounts (user_id)
    VALUES (${user.id})
    ON CONFLICT (user_id) DO UPDATE SET updated_at = billing_accounts.updated_at
    RETURNING credit_balance_cents, auto_refill_enabled, auto_refill_threshold_cents,
      auto_refill_amount_cents, recurring_enabled, stripe_subscription_id, stripe_payment_method_id
  `;
  return rowToBillingAccount(rows[0] as BillingRow);
}

export async function getUsageSummary(user: User | null, anonymousId: string | null) {
  await ensureSchema();
  const account = user ? await getOrCreateBillingAccount(user) : null;
  const anonTextUsed = anonymousId
    ? await countUsage({ anonymousId, extractionKind: "text", freeOnly: true })
    : 0;
  const userTextUsed = user
    ? await countUsage({ userId: user.id, extractionKind: "text", freeOnly: true })
    : 0;
  const userFullUsed = user
    ? await countUsage({ userId: user.id, extractionKind: "full", freeOnly: true })
    : 0;
  return {
    account,
    free: {
      anonymousTextRemaining: Math.max(0, FREE_TEXT_EXTRACTIONS_ANONYMOUS - anonTextUsed),
      authenticatedTextRemaining: Math.max(0, FREE_TEXT_EXTRACTIONS_AUTHENTICATED - userTextUsed),
      authenticatedFullRemaining: Math.max(0, FREE_FULL_EXTRACTIONS_AUTHENTICATED - userFullUsed)
    },
    prices: CREDIT_PRICES_CENTS,
    platform: await getPlatformBalance()
  };
}

export async function authorizeExtraction(params: {
  user: User | null;
  anonymousId: string | null;
  extractionKind: ExtractionKind;
  sourceUrl: string;
  durationSeconds: number;
  estimatedCostCents: number;
}): Promise<UsageGrant> {
  await ensureSchema();
  if (!params.user && params.extractionKind === "full") {
    throw new Error("Sign in to run full context extractions.");
  }

  const platform = await getPlatformBalance();
  if (platform.netLossCents + params.estimatedCostCents > PLATFORM_MAX_NET_LOSS_CENTS) {
    throw new Error("The service is at its shared cost ceiling. Add credits before running more extractions.");
  }

  const grantId = randomUUID();
  const priceCents = CREDIT_PRICES_CENTS[params.extractionKind];
  let freeQuotaUsed = false;
  let creditsSpentCents = 0;
  let creditBalanceCents = 0;
  let remainingFree = 0;

  if (params.user) {
    const freeLimit =
      params.extractionKind === "text"
        ? FREE_TEXT_EXTRACTIONS_AUTHENTICATED
        : FREE_FULL_EXTRACTIONS_AUTHENTICATED;
    const used = await countUsage({
      userId: params.user.id,
      extractionKind: params.extractionKind,
      freeOnly: true
    });
    remainingFree = Math.max(0, freeLimit - used);
    if (remainingFree > 0) {
      freeQuotaUsed = true;
      remainingFree -= 1;
      creditBalanceCents = (await getOrCreateBillingAccount(params.user)).creditBalanceCents;
    } else {
      creditBalanceCents = await spendCredits(params.user.id, priceCents);
      creditsSpentCents = priceCents;
    }
  } else {
    const anonymousId = params.anonymousId;
    if (!anonymousId) throw new Error("Anonymous usage could not be tracked.");
    const used = await countUsage({
      anonymousId,
      extractionKind: "text",
      freeOnly: true
    });
    remainingFree = Math.max(0, FREE_TEXT_EXTRACTIONS_ANONYMOUS - used);
    if (remainingFree <= 0) {
      throw new Error("Your free text-only extractions are used. Sign in to continue.");
    }
    freeQuotaUsed = true;
    remainingFree -= 1;
  }

  await sql`
    INSERT INTO usage_events (
      id,
      user_id,
      anonymous_id,
      extraction_kind,
      free_quota_used,
      credits_spent_cents,
      estimated_cost_cents,
      source_url,
      duration_seconds
    )
    VALUES (
      ${grantId},
      ${params.user?.id ?? null},
      ${params.anonymousId},
      ${params.extractionKind},
      ${freeQuotaUsed},
      ${creditsSpentCents},
      ${params.estimatedCostCents},
      ${params.sourceUrl},
      ${Math.max(0, Math.floor(params.durationSeconds))}
    )
  `;
  await sql`
    INSERT INTO billing_ledger (id, user_id, kind, amount_cents, estimated_cost_cents, metadata)
    VALUES (
      ${randomUUID()},
      ${params.user?.id ?? null},
      'usage_cost',
      0,
      ${params.estimatedCostCents},
      ${JSON.stringify({ usageId: grantId, extractionKind: params.extractionKind })}::jsonb
    )
  `;

  return {
    grantId,
    extractionKind: params.extractionKind,
    billToUserId: params.user?.id ?? null,
    anonymousId: params.anonymousId,
    freeQuotaUsed,
    creditsSpentCents,
    estimatedCostCents: params.estimatedCostCents,
    remainingFree,
    creditBalanceCents
  };
}

export async function addCredits(params: {
  userId: string;
  amountCents: number;
  stripeEventId?: string;
  kind: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO billing_accounts (user_id, credit_balance_cents)
    VALUES (${params.userId}, ${params.amountCents})
    ON CONFLICT (user_id) DO UPDATE
    SET credit_balance_cents = billing_accounts.credit_balance_cents + ${params.amountCents},
        updated_at = NOW()
  `;
  await sql`
    INSERT INTO billing_ledger (id, user_id, stripe_event_id, kind, amount_cents, estimated_cost_cents, metadata)
    VALUES (
      ${randomUUID()},
      ${params.userId},
      ${params.stripeEventId ?? null},
      ${params.kind},
      ${params.amountCents},
      0,
      ${JSON.stringify(params.metadata ?? {})}::jsonb
    )
    ON CONFLICT (stripe_event_id) DO NOTHING
  `;
}

export async function refundUsageGrant(grant: UsageGrant): Promise<void> {
  await ensureSchema();
  if (grant.creditsSpentCents > 0 && grant.billToUserId) {
    await sql`
      UPDATE billing_accounts
      SET credit_balance_cents = credit_balance_cents + ${grant.creditsSpentCents},
          updated_at = NOW()
      WHERE user_id = ${grant.billToUserId}
    `;
  }
  await sql`
    DELETE FROM billing_ledger
    WHERE kind = 'usage_cost'
      AND metadata->>'usageId' = ${grant.grantId}
  `;
  await sql`DELETE FROM usage_events WHERE id = ${grant.grantId}`;
}

export async function updateBillingSettings(
  user: User,
  settings: Partial<
    Pick<
      BillingAccount,
      "autoRefillEnabled" | "autoRefillThresholdCents" | "autoRefillAmountCents" | "recurringEnabled"
    >
  >
): Promise<BillingAccount> {
  await ensureSchema();
  await getOrCreateBillingAccount(user);
  const current = await getOrCreateBillingAccount(user);
  const next = {
    autoRefillEnabled: settings.autoRefillEnabled ?? current.autoRefillEnabled,
    autoRefillThresholdCents:
      settings.autoRefillThresholdCents ?? current.autoRefillThresholdCents,
    autoRefillAmountCents: settings.autoRefillAmountCents ?? current.autoRefillAmountCents,
    recurringEnabled: settings.recurringEnabled ?? current.recurringEnabled
  };
  const rows = await sql`
    UPDATE billing_accounts
    SET auto_refill_enabled = ${next.autoRefillEnabled},
        auto_refill_threshold_cents = ${Math.max(100, Math.min(10000, next.autoRefillThresholdCents))},
        auto_refill_amount_cents = ${Math.max(500, Math.min(20000, next.autoRefillAmountCents))},
        recurring_enabled = ${next.recurringEnabled},
        updated_at = NOW()
    WHERE user_id = ${user.id}
    RETURNING credit_balance_cents, auto_refill_enabled, auto_refill_threshold_cents,
      auto_refill_amount_cents, recurring_enabled, stripe_subscription_id, stripe_payment_method_id
  `;
  return rowToBillingAccount(rows[0] as BillingRow);
}

export async function setStripeCustomer(userId: string, customerId: string): Promise<void> {
  await ensureSchema();
  await sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${userId}`;
}

export async function findUserByStripeCustomer(customerId: string): Promise<User | null> {
  await ensureSchema();
  const rows = await sql`
    SELECT id, email
    FROM users
    WHERE stripe_customer_id = ${customerId}
    LIMIT 1
  `;
  return (rows[0] as User | undefined) ?? null;
}

export async function setSubscription(params: {
  userId: string;
  subscriptionId: string | null;
  recurringEnabled: boolean;
}): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO billing_accounts (user_id, stripe_subscription_id, recurring_enabled)
    VALUES (${params.userId}, ${params.subscriptionId}, ${params.recurringEnabled})
    ON CONFLICT (user_id) DO UPDATE
    SET stripe_subscription_id = ${params.subscriptionId},
        recurring_enabled = ${params.recurringEnabled},
        updated_at = NOW()
  `;
}

export async function setPaymentMethod(params: {
  userId: string;
  paymentMethodId: string | null;
}): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO billing_accounts (user_id, stripe_payment_method_id)
    VALUES (${params.userId}, ${params.paymentMethodId})
    ON CONFLICT (user_id) DO UPDATE
    SET stripe_payment_method_id = ${params.paymentMethodId},
        updated_at = NOW()
  `;
}

async function countUsage(params: {
  userId?: string;
  anonymousId?: string;
  extractionKind: ExtractionKind;
  freeOnly?: boolean;
}): Promise<number> {
  const rows = params.userId
    ? await sql`
        SELECT COUNT(*) AS count
        FROM usage_events
        WHERE user_id = ${params.userId}
          AND extraction_kind = ${params.extractionKind}
          AND (${params.freeOnly ?? false} = FALSE OR free_quota_used = TRUE)
      `
    : await sql`
        SELECT COUNT(*) AS count
        FROM usage_events
        WHERE anonymous_id = ${params.anonymousId}
          AND extraction_kind = ${params.extractionKind}
          AND (${params.freeOnly ?? false} = FALSE OR free_quota_used = TRUE)
      `;
  return Number((rows[0] as { count: number | string }).count ?? 0);
}

async function spendCredits(userId: string, amountCents: number): Promise<number> {
  await sql`
    INSERT INTO billing_accounts (user_id)
    VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `;
  const rows = await sql`
    UPDATE billing_accounts
    SET credit_balance_cents = credit_balance_cents - ${amountCents},
        updated_at = NOW()
    WHERE user_id = ${userId}
      AND credit_balance_cents >= ${amountCents}
    RETURNING credit_balance_cents
  `;
  if (!rows[0]) throw new Error("Not enough credits. Buy credits or enable a recurring refill.");
  return Number((rows[0] as { credit_balance_cents: number | string }).credit_balance_cents);
}

async function getPlatformBalance(): Promise<{
  revenueCents: number;
  estimatedCostCents: number;
  netLossCents: number;
}> {
  const rows = await sql`
    SELECT
      COALESCE(SUM(amount_cents), 0) AS revenue_cents,
      COALESCE(SUM(estimated_cost_cents), 0) AS estimated_cost_cents
    FROM billing_ledger
  `;
  const row = rows[0] as { revenue_cents: number | string; estimated_cost_cents: number | string };
  const revenueCents = Number(row.revenue_cents ?? 0);
  const estimatedCostCents = Number(row.estimated_cost_cents ?? 0);
  return {
    revenueCents,
    estimatedCostCents,
    netLossCents: Math.max(0, estimatedCostCents - revenueCents)
  };
}

function rowToBillingAccount(row: BillingRow): BillingAccount {
  return {
    creditBalanceCents: Number(row.credit_balance_cents ?? 0),
    autoRefillEnabled: Boolean(row.auto_refill_enabled),
    autoRefillThresholdCents: Number(row.auto_refill_threshold_cents ?? 200),
    autoRefillAmountCents: Number(row.auto_refill_amount_cents ?? 1000),
    recurringEnabled: Boolean(row.recurring_enabled),
    stripeSubscriptionId: row.stripe_subscription_id ?? undefined,
    stripePaymentMethodId: row.stripe_payment_method_id ?? undefined
  };
}
