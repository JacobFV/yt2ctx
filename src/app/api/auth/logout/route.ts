import { NextResponse } from "next/server";

import { clearSessionCookie, destroySession } from "../../../../server/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  await destroySession(request);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
