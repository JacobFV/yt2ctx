import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { createUserSession, setSessionCookie, validateCredentials } from "../../../../server/auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string(),
  password: z.string()
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const validationError = validateCredentials(parsed.data.email, parsed.data.password);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  try {
    const { user, sessionId, expiresAt } = await createUserSession(
      parsed.data.email,
      parsed.data.password
    );
    const response = NextResponse.json({ user });
    setSessionCookie(response, sessionId, expiresAt);
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create account." },
      { status: 400 }
    );
  }
}
