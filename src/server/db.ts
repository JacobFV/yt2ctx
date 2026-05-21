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
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
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
  })();
  return schemaReady;
}
