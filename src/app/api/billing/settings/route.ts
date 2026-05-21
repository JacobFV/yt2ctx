import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { requireUser } from "../../../../server/auth";
import { getUsageSummary, updateBillingSettings } from "../../../../server/billing";

export const runtime = "nodejs";

const schema = z.object({
  autoRefillEnabled: z.boolean().optional(),
  autoRefillThresholdCents: z.number().int().min(100).max(10000).optional(),
  autoRefillAmountCents: z.number().int().min(500).max(20000).optional(),
  recurringEnabled: z.boolean().optional()
});

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return NextResponse.json({ billing: await getUsageSummary(user, null) });
  } catch {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const settings = schema.parse(await request.json());
    const account = await updateBillingSettings(user, settings);
    return NextResponse.json({ account });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update billing settings." },
      { status: 400 }
    );
  }
}
