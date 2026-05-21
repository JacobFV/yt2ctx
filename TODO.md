# Roadmap

## Make the hosted web app safe to expose publicly

> **Current state.** `POST /api/analyze` is gated behind first-party
> email/password authentication and saves completed analyses to Neon Postgres.
> Every authenticated call still spends real money: OpenAI transcription, one
> vision call per candidate frame (up to 36), embeddings, and a large
> grammar-compilation call — roughly **$0.05–0.30 per analysis** — plus Vercel
> function compute (300 s Node functions on Active-CPU pricing). A public
> signup flow still needs quotas and abuse controls before wide distribution.
>
> **Scope.** This only affects the **hosted web deployment**. The CLI and MCP
> server run on the *caller's own* `OPENAI_API_KEY`, so they carry no spend
> exposure and stay free and unrestricted. Everything below is about gating the
> web app.

The goal: add per-user quotas and hard cost ceilings, then optionally upgrade
the first-party auth flow to **Google OAuth + Stripe subscriptions**, so spend
is always bounded and attributable.

---

### Phase 0 — Immediate guardrails (ship before any public link)

Cheap protections that work even before auth exists.

- [ ] Add per-IP rate limiting to `/api/analyze` (e.g. Upstash Redis +
      `@upstash/ratelimit`, or Vercel Firewall rate-limit rules).
- [ ] Add a **global daily spend ceiling** with a kill switch — a counter that,
      once exceeded, makes the route return `503` until reset.
- [ ] Cap the hosted path: reject videos over a max duration, and clamp
      `maxCandidateFrames` / `topK` to conservative values server-side.
- [ ] Enable Vercel BotID / Attack Challenge on the analyze route.
- [ ] Add a cost estimate to the result payload and log per-request spend.

### Phase 1 — Authentication

- [x] Add first-party email/password accounts with HttpOnly Postgres-backed sessions.
- [x] Add sign-in / sign-out UI; gate the composer behind a signed-in session.
- [x] Reject unauthenticated `POST /api/analyze` with `401`.
- [ ] Optional: add **Auth.js (NextAuth v5)** with the Google provider
      (`@auth/core` + `next-auth`). Configure the Google OAuth client
      (consent screen, authorized redirect URIs).
- [ ] Optional: add `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `AUTH_SECRET` to env
      and to Vercel project settings; document them in `.env.example`.
- [ ] _Decision:_ Auth.js (no vendor, OSS-friendly) vs. Clerk (faster, native
      Vercel Marketplace integration). Default recommendation: **Auth.js**.

### Phase 2 — Persistence & usage metering

- [x] Provision a database — **Neon Postgres** via the Vercel Marketplace
      (or Upstash Redis if only counters are needed).
- [x] Schema: `users`, `sessions`, `videos`.
- [x] Save every completed analysis payload to the signed-in user's video library.
- [ ] Add usage tables for period counts and estimated spend.
- [ ] Record every analysis cost estimate.
- [ ] Enforce a **free-tier quota** server-side *before* starting the pipeline
      (e.g. 3 analyses / month); return `402` when exhausted.
- [ ] Surface remaining quota in the UI.

### Phase 3 — Stripe subscriptions

- [ ] Create Stripe products/prices: **Free**, **Pro** (monthly, higher quota),
      and optionally metered pay-as-you-go.
- [ ] Implement **Stripe Checkout** for upgrade and the **Customer Portal** for
      managing/cancelling.
- [ ] Add a `POST /api/stripe/webhook` handler for
      `checkout.session.completed`, `customer.subscription.updated`, and
      `customer.subscription.deleted`; verify the signing secret.
- [ ] Map subscription status → plan → monthly quota; store on the user.
- [ ] Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and price IDs to env.

### Phase 4 — Hard cost controls

- [ ] Per-request pre-flight cost estimate; refuse runs that would exceed the
      user's remaining budget.
- [ ] Global **monthly budget cap** with a circuit breaker independent of
      per-user quotas.
- [ ] Spend alerting (email / webhook) at configurable thresholds.
- [ ] Abuse detection: flag rapid repeat URLs and anomalous patterns.

### Phase 5 — Billing UX

- [ ] Pricing page with plan comparison.
- [ ] Account page: current plan, usage this period, manage-billing link.
- [ ] Email receipts and quota-warning notifications.

---

## Open decisions

- **Auth provider** — Auth.js vs. Clerk.
- **Database** — Neon Postgres vs. Upstash Redis (vs. both).
- **Pricing** — free-tier size, Pro price point, and whether to offer metered
  pay-as-you-go.
- **Plan enforcement** — block at quota, or allow overage billing.

## Smaller follow-ups

- [x] Persisted job history so a completed analysis can be revisited by `id`.
- [ ] Resumable / re-connectable streaming if a client drops mid-run.
- [ ] An OG image for link previews.
- [ ] Tests for the core pipeline and the streaming route.
