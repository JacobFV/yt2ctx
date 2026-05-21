import { NextResponse } from "next/server";

import { requireUser } from "../../../server/auth";
import { listVideos } from "../../../server/videos";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return NextResponse.json({ videos: await listVideos(user) });
  } catch {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
}
