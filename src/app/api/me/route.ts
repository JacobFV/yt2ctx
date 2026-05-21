import { NextResponse } from "next/server";

import { userFromRequest } from "../../../server/auth";
import {
  anonymousCookieHeader,
  anonymousIdFromRequest,
  createAnonymousId,
  getUsageSummary
} from "../../../server/billing";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await userFromRequest(request);
  const existingAnonymousId = anonymousIdFromRequest(request);
  const anonymousId = existingAnonymousId ?? createAnonymousId();
  const billing = await getUsageSummary(user, anonymousId);
  const response = NextResponse.json({ user, billing });
  if (!existingAnonymousId) response.headers.append("Set-Cookie", anonymousCookieHeader(anonymousId));
  return response;
}
