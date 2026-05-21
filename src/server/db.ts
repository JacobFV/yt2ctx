import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let schemaReady: Promise<void> | null = null;
let client: NeonQueryFunction<false, false> | null = null;

function connectionString(): string {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not configured.");
  return url;
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  client ??= neon(connectionString());
  return client(strings, ...values);
}

export async function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        stripe_customer_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS users_stripe_customer_idx ON users(stripe_customer_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS videos (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        analysis_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        video_id TEXT,
        title TEXT NOT NULL,
        uploader TEXT,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        frame_count INTEGER NOT NULL DEFAULT 0,
        result JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS videos_user_created_idx ON videos(user_id, created_at DESC)
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS billing_accounts (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        credit_balance_cents INTEGER NOT NULL DEFAULT 0,
        auto_refill_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        auto_refill_threshold_cents INTEGER NOT NULL DEFAULT 200,
        auto_refill_amount_cents INTEGER NOT NULL DEFAULT 1000,
        recurring_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        stripe_subscription_id TEXT,
        stripe_payment_method_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS usage_events (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        anonymous_id TEXT,
        extraction_kind TEXT NOT NULL CHECK (extraction_kind IN ('text', 'full')),
        free_quota_used BOOLEAN NOT NULL DEFAULT FALSE,
        credits_spent_cents INTEGER NOT NULL DEFAULT 0,
        estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
        source_url TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events(user_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS usage_events_anon_idx ON usage_events(anonymous_id, created_at DESC)`;
    await sql`
      CREATE TABLE IF NOT EXISTS billing_ledger (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        stripe_event_id TEXT UNIQUE,
        kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS billing_ledger_user_idx ON billing_ledger(user_id, created_at DESC)`;
  })();
  return schemaReady;
}
