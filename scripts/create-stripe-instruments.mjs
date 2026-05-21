import Stripe from "stripe";

const mode = process.argv.includes("--prod") ? "prod" : "dev";
const key =
  mode === "prod"
    ? process.env.STRIPE_SECRET_KEY_PROD || process.env.STRIPE_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY_DEV || process.env.STRIPE_SECRET_KEY;

if (!key) {
  throw new Error(
    `Set ${mode === "prod" ? "STRIPE_SECRET_KEY_PROD" : "STRIPE_SECRET_KEY_DEV"} or STRIPE_SECRET_KEY.`
  );
}

const stripe = new Stripe(key);

async function upsertProduct(name, metadata) {
  const existing = await stripe.products.search({
    query: `metadata['yt2ctx_id']:'${metadata.yt2ctx_id}'`,
    limit: 1
  });
  if (existing.data[0]) return existing.data[0];
  return stripe.products.create({ name, metadata });
}

async function createOneTimePrice(product, amount) {
  return stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: amount
  });
}

async function createRecurringPrice(product, amount) {
  return stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month" }
  });
}

const starter = await upsertProduct("yt2ctx Starter credits", {
  yt2ctx_id: "starter_credits",
  credits_cents: "500"
});
const studio = await upsertProduct("yt2ctx Studio credits", {
  yt2ctx_id: "studio_credits",
  credits_cents: "2200"
});
const recurring = await upsertProduct("yt2ctx Monthly credit refill", {
  yt2ctx_id: "monthly_refill",
  credits_cents: "1100"
});

const prices = {
  starter: await createOneTimePrice(starter, 500),
  studio: await createOneTimePrice(studio, 2000),
  monthly: await createRecurringPrice(recurring, 1000)
};

console.log(
  JSON.stringify(
    {
      mode,
      products: {
        starter: starter.id,
        studio: studio.id,
        monthly: recurring.id
      },
      prices: {
        starter: prices.starter.id,
        studio: prices.studio.id,
        monthly: prices.monthly.id
      },
      webhookEndpoint:
        process.env.NEXT_PUBLIC_APP_URL &&
        `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/stripe/webhook`
    },
    null,
    2
  )
);
