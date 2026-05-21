import { NextResponse } from "next/server";

import {
  addCredits,
  findUserByStripeCustomer,
  setPaymentMethod,
  setSubscription
} from "../../../../server/billing";
import { RECURRING_PACK } from "../../../../server/pricing";
import { stripe } from "../../../../server/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: "Stripe webhook is not configured." }, { status: 400 });
  }

  let event;
  try {
    event = stripe().webhooks.constructEvent(await request.text(), signature, webhookSecret);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Stripe signature." },
      { status: 400 }
    );
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (session.mode === "payment" && userId) {
        await addCredits({
          userId,
          amountCents: Number(session.metadata?.creditsCents ?? 0),
          stripeEventId: event.id,
          kind: "credit_purchase",
          metadata: { checkoutSessionId: session.id, packId: session.metadata?.packId }
        });
      }
      if (session.mode === "setup" && userId && session.setup_intent) {
        const setupIntent = await stripe().setupIntents.retrieve(String(session.setup_intent));
        const paymentMethodId =
          typeof setupIntent.payment_method === "string"
            ? setupIntent.payment_method
            : setupIntent.payment_method?.id;
        if (paymentMethodId) await setPaymentMethod({ userId, paymentMethodId });
      }
      if (session.mode === "subscription" && userId && session.subscription) {
        await setSubscription({
          userId,
          subscriptionId: String(session.subscription),
          recurringEnabled: true
        });
      }
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const invoiceWithDetails = invoice as typeof invoice & {
        subscription_details?: { metadata?: Record<string, string> };
        parent?: { subscription_details?: { metadata?: Record<string, string> } };
      };
      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const userId =
        invoiceWithDetails.subscription_details?.metadata?.userId ||
        invoiceWithDetails.parent?.subscription_details?.metadata?.userId ||
        (customerId ? (await findUserByStripeCustomer(customerId))?.id : undefined);
      if (userId) {
        await addCredits({
          userId,
          amountCents: Number(
            invoiceWithDetails.subscription_details?.metadata?.creditsCents ||
              invoiceWithDetails.parent?.subscription_details?.metadata?.creditsCents ||
              RECURRING_PACK.creditsCents
          ),
          stripeEventId: event.id,
          kind: "subscription_refill",
          metadata: { invoiceId: invoice.id }
        });
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id;
      const user = customerId ? await findUserByStripeCustomer(customerId) : null;
      if (user) {
        await setSubscription({
          userId: user.id,
          subscriptionId: null,
          recurringEnabled: false
        });
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Webhook handling failed." },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}
