import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

import { ensureSchema, sql } from "./db";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "yt2ctx_session";
const SESSION_DAYS = 30;

export type User = {
  id: string;
  email: string;
  stripeCustomerId?: string | null;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateCredentials(email: string, password: string): string | null {
  const normalized = normalizeEmail(email);
  if (!validateEmail(normalized)) return "Enter a valid email address.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 256) return "Password is too long.";
  return null;
}

export function sessionCookieValue(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const cookies = header.split(";").map((part) => part.trim());
  for (const cookie of cookies) {
    const [name, ...value] = cookie.split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, salt, stored] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !stored) return false;
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const storedBuffer = Buffer.from(stored, "base64url");
  return storedBuffer.length === key.length && timingSafeEqual(storedBuffer, key);
}

function sessionExpiresAt(): Date {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

export function setSessionCookie(response: NextResponse, sessionId: string, expires: Date): void {
  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0)
  });
}

export async function createUserSession(email: string, password: string): Promise<{
  user: User;
  sessionId: string;
  expiresAt: Date;
}> {
  await ensureSchema();
  const normalized = normalizeEmail(email);
  const userId = randomUUID();
  const sessionId = randomUUID();
  const expiresAt = sessionExpiresAt();
  const passwordHash = await hashPassword(password);

  try {
    await sql`
      INSERT INTO users (id, email, password_hash)
      VALUES (${userId}, ${normalized}, ${passwordHash})
    `;
  } catch (error) {
    if (error instanceof Error && error.message.includes("duplicate key")) {
      throw new Error("An account with that email already exists.");
    }
    throw error;
  }

  await sql`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${sessionId}, ${userId}, ${expiresAt.toISOString()})
  `;

  await sql`
    INSERT INTO billing_accounts (user_id)
    VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `;

  return { user: { id: userId, email: normalized, stripeCustomerId: null }, sessionId, expiresAt };
}

export async function loginUser(email: string, password: string): Promise<{
  user: User;
  sessionId: string;
  expiresAt: Date;
}> {
  await ensureSchema();
  const normalized = normalizeEmail(email);
  const rows = await sql`
    SELECT id, email, password_hash, stripe_customer_id
    FROM users
    WHERE email = ${normalized}
    LIMIT 1
  `;
  const user = rows[0] as
    | { id: string; email: string; password_hash: string; stripe_customer_id: string | null }
    | undefined;
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new Error("Invalid email or password.");
  }

  const sessionId = randomUUID();
  const expiresAt = sessionExpiresAt();
  await sql`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${sessionId}, ${user.id}, ${expiresAt.toISOString()})
  `;

  return {
    user: { id: user.id, email: user.email, stripeCustomerId: user.stripe_customer_id },
    sessionId,
    expiresAt
  };
}

export async function userFromRequest(request: Request): Promise<User | null> {
  const sessionId = sessionCookieValue(request);
  if (!sessionId) return null;
  await ensureSchema();

  const rows = await sql`
    SELECT users.id, users.email, users.stripe_customer_id AS "stripeCustomerId"
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ${sessionId}
      AND sessions.expires_at > NOW()
    LIMIT 1
  `;
  const user = rows[0] as User | undefined;
  return user ?? null;
}

export async function requireUser(request: Request): Promise<User> {
  const user = await userFromRequest(request);
  if (!user) throw new Error("Authentication required.");
  return user;
}

export async function destroySession(request: Request): Promise<void> {
  const sessionId = sessionCookieValue(request);
  if (!sessionId) return;
  await ensureSchema();
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
}
