import { NextResponse } from "next/server";

import { requireUser } from "../../../../server/auth";
import { createPortalSession } from "../../../../server/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const session = await createPortalSession({ user, request });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not open billing portal." },
      { status: 400 }
    );
  }
}
