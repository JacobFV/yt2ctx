import { NextResponse } from "next/server";

import { requireUser } from "../../../../server/auth";
import { deleteVideo, getVideo } from "../../../../server/videos";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const video = await getVideo(user, id);
    if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });
    return NextResponse.json({ video });
  } catch {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    await deleteVideo(user, id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
}
