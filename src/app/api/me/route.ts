import { NextResponse } from "next/server";

import { userFromRequest } from "../../../server/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await userFromRequest(request);
  return NextResponse.json({ user });
}
