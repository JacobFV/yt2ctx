import Stripe from "stripe";

import type { User } from "./auth";
import { ensureSchema, sql } from "./db";
import { addCredits, getOrCreateBillingAccount, setStripeCustomer } from "./billing";
import { CREDIT_PACKS, RECURRING_PACK, type CreditPackId } from "./pricing";

let stripeClient: Stripe | null = null;

export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  stripeClient ??= new Stripe(key);
  return stripeClient;
}

function stripeMode(): "DEV" | "PROD" {
  return process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "PROD" : "DEV";
}

function priceFromEnv(baseName: string): string | undefined {
  return process.env[`${baseName}_${stripeMode()}`] || process.env[baseName];
}

export function appUrl(request: Request): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    `${new URL(request.url).protocol}//${new URL(request.url).host}`
  ).replace(/\/$/, "");
}

export async function getOrCreateStripeCustomer(user: User): Promise<string> {
  await ensureSchema();
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const existing = await sql`
    SELECT stripe_customer_id
    FROM users
    WHERE id = ${user.id}
    LIMIT 1
  `;
  const row = existing[0] as { stripe_customer_id: string | null } | undefined;
  if (row?.stripe_customer_id) return row.stripe_customer_id;

  const customer = await stripe().customers.create({
    email: user.email,
    metadata: { userId: user.id }
  });
  await setStripeCustomer(user.id, customer.id);
  return customer.id;
}

export async function createCreditCheckoutSession(params: {
  user: User;
  packId: CreditPackId;
  request: Request;
}): Promise<Stripe.Checkout.Session> {
  const pack = CREDIT_PACKS[params.packId];
  const configuredPrice =
    params.packId === "starter"
      ? priceFromEnv("STRIPE_PRICE_CREDITS_STARTER")
      : priceFromEnv("STRIPE_PRICE_CREDITS_STUDIO");
  const customer = await getOrCreateStripeCustomer(params.user);
  const origin = appUrl(params.request);
  return stripe().checkout.sessions.create({
    mode: "payment",
    customer,
    line_items: [
      configuredPrice
        ? { price: configuredPrice, quantity: 1 }
        : {
            price_data: {
              currency: "usd",
              product_data: { name: pack.name },
              unit_amount: pack.amountCents
            },
            quantity: 1
          }
    ],
    metadata: {
      userId: params.user.id,
      purchaseType: "credits",
      packId: pack.id,
      creditsCents: String(pack.creditsCents)
    },
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancelled`
  });
}

export async function createRecurringCheckoutSession(params: {
  user: User;
  request: Request;
}): Promise<Stripe.Checkout.Session> {
  const customer = await getOrCreateStripeCustomer(params.user);
  const origin = appUrl(params.request);
  const configuredPrice = priceFromEnv("STRIPE_PRICE_MONTHLY_REFILL");
  return stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [
      configuredPrice
        ? { price: configuredPrice, quantity: 1 }
        : {
            price_data: {
              currency: "usd",
              recurring: { interval: RECURRING_PACK.interval },
              product_data: { name: RECURRING_PACK.name },
              unit_amount: RECURRING_PACK.amountCents
            },
            quantity: 1
          }
    ],
    subscription_data: {
      metadata: {
        userId: params.user.id,
        purchaseType: "recurring",
        creditsCents: String(RECURRING_PACK.creditsCents)
      }
    },
    metadata: {
      userId: params.user.id,
      purchaseType: "recurring",
      creditsCents: String(RECURRING_PACK.creditsCents)
    },
    success_url: `${origin}/?billing=subscription`,
    cancel_url: `${origin}/?billing=cancelled`
  });
}

export async function createSetupCheckoutSession(params: {
  user: User;
  request: Request;
}): Promise<Stripe.Checkout.Session> {
  const customer = await getOrCreateStripeCustomer(params.user);
  const origin = appUrl(params.request);
  return stripe().checkout.sessions.create({
    mode: "setup",
    customer,
    payment_method_types: ["card"],
    metadata: {
      userId: params.user.id,
      purchaseType: "setup"
    },
    success_url: `${origin}/?billing=setup`,
    cancel_url: `${origin}/?billing=cancelled`
  });
}

export async function createPortalSession(params: {
  user: User;
  request: Request;
}): Promise<Stripe.BillingPortal.Session> {
  const customer = await getOrCreateStripeCustomer(params.user);
  return stripe().billingPortal.sessions.create({
    customer,
    return_url: appUrl(params.request)
  });
}

export async function autoRefillIfNeeded(user: User): Promise<void> {
  const account = await getOrCreateBillingAccount(user);
  if (!account.autoRefillEnabled) return;
  if (account.creditBalanceCents > account.autoRefillThresholdCents) return;
  if (!account.stripePaymentMethodId) return;
  const customer = await getOrCreateStripeCustomer(user);
  const intent = await stripe().paymentIntents.create({
    amount: account.autoRefillAmountCents,
    currency: "usd",
    customer,
    payment_method: account.stripePaymentMethodId,
    off_session: true,
    confirm: true,
    metadata: {
      userId: user.id,
      purchaseType: "auto_refill",
      creditsCents: String(account.autoRefillAmountCents)
    }
  });
  if (intent.status === "succeeded") {
    await addCredits({
      userId: user.id,
      amountCents: account.autoRefillAmountCents,
      kind: "auto_refill",
      metadata: { paymentIntentId: intent.id }
    });
  }
}
